#include "audio/virtual/dsound_mixer.h"

#include <stdlib.h>
#include <string.h>
#include <windows.h>

#include "audio/dsound.h"
#include "audio/virtual/mix_math.h"
#include "core/log.h"
#include "core/runtime_config.h"
#include "core/vtable_hook.h"
#include "present/capture/frame_sync.h"

namespace autoplay::audio::dsound_mixer {

namespace {

constexpr int kOutRate = 44100;
constexpr int kSamplesPerFrame = kOutRate / 60;  // 735
constexpr DWORD kDSBPLAY_LOOPING = 0x1;
constexpr DWORD kDSBSTATUS_PLAYING = 0x1;
constexpr DWORD kDSBSTATUS_LOOPING = 0x4;
constexpr DWORD kDSBLOCK_FROMWRITECURSOR = 0x1;
constexpr DWORD kDSBLOCK_ENTIREBUFFER = 0x2;
constexpr DWORD kDSBPN_OFFSETSTOP = 0xFFFFFFFF;

struct DSBufferDescMin {
    DWORD dwSize;
    DWORD dwFlags;
    DWORD dwBufferBytes;
    DWORD dwReserved;
    void* lpwfxFormat;
};
struct WaveFormatExMin {
    WORD wFormatTag;
    WORD nChannels;
    DWORD nSamplesPerSec;
    DWORD nAvgBytesPerSec;
    WORD nBlockAlign;
    WORD wBitsPerSample;
};
struct PositionNotify {
    DWORD dwOffset;
    HANDLE hEventNotify;
};

typedef HRESULT(WINAPI* QueryInterface_t)(void*, REFIID, void**);
typedef ULONG(WINAPI* Release_t)(void*);
typedef HRESULT(WINAPI* GetCurrentPosition_t)(void*, DWORD*, DWORD*);
typedef HRESULT(WINAPI* GetStatus_t)(void*, DWORD*);
typedef HRESULT(WINAPI* Lock_t)(void*, DWORD, DWORD, void**, DWORD*, void**, DWORD*, DWORD);
typedef HRESULT(WINAPI* Play_t)(void*, DWORD, DWORD, DWORD);
typedef HRESULT(WINAPI* SetCurrentPosition_t)(void*, DWORD);
typedef HRESULT(WINAPI* SetLong_t)(void*, LONG);
typedef HRESULT(WINAPI* SetFrequency_t)(void*, DWORD);
typedef HRESULT(WINAPI* Stop_t)(void*);
typedef HRESULT(WINAPI* Unlock_t)(void*, void*, DWORD, void*, DWORD);
typedef HRESULT(WINAPI* SetNotificationPositions_t)(void*, DWORD, const PositionNotify*);

QueryInterface_t g_origQI = nullptr;
Release_t g_origRelease = nullptr;
GetCurrentPosition_t g_origGetPos = nullptr;
GetStatus_t g_origGetStatus = nullptr;
Lock_t g_origLock = nullptr;
Play_t g_origPlay = nullptr;
SetCurrentPosition_t g_origSetPos = nullptr;
SetLong_t g_origSetVolume = nullptr;
SetLong_t g_origSetPan = nullptr;
SetFrequency_t g_origSetFrequency = nullptr;
Stop_t g_origStop = nullptr;
Unlock_t g_origUnlock = nullptr;
SetNotificationPositions_t g_origSetNotify = nullptr;

const GUID kIID_IDirectSoundNotify = {
    0xb0210783, 0x89cd, 0x11d0, {0xaf, 0x08, 0x00, 0xa0, 0xc9, 0x25, 0xcd, 0x16}};

// DuplicateSoundBuffer の複製は元と同じメモリを共有するので、写しも参照カウントで共有する。
struct Shadow {
    BYTE* data;
    LONG refs;
};

Shadow* NewShadow(DWORD bytes, bool unsigned8) {
    auto* sh = (Shadow*)calloc(1, sizeof(Shadow));
    sh->data = (BYTE*)calloc(bytes ? bytes : 1, 1);
    if (unsigned8) memset(sh->data, 0x80, bytes);
    sh->refs = 1;
    return sh;
}

void ReleaseShadow(Shadow* sh) {
    if (sh && --sh->refs == 0) {
        free(sh->data);
        free(sh);
    }
}

constexpr int kMaxNotify = 64;
struct VBuf {
    void* ptr;
    void* notify;
    bool alive;
    int id;
    DWORD bytes, rate, freq;
    WORD channels, bits, block;
    DWORD frames;
    Shadow* sh;
    BYTE* shadow;
    bool playing, looping;
    double pos;
    LONG volume, pan;
    float gainL, gainR;
    DWORD lockOff;
    int nnotify;
    PositionNotify notifies[kMaxNotify];
    volatile LONG unlockSeq;
};

constexpr int kMaxBufs = 512;
VBuf g_bufs[kMaxBufs];
int g_nbufs = 0;
int g_nextId = 0;
CRITICAL_SECTION g_cs;
bool g_active = false;
HANDLE g_file = INVALID_HANDLE_VALUE;
LONGLONG g_framesMixed = 0;
LONGLONG g_framesWritten = 0;
LONG g_notifiesFired = 0;
LONG g_refillTimeouts = 0;
LONG g_unknownPlays = 0;
DWORD g_refillWaitMs = 500;
float g_mix[kSamplesPerFrame * 2];
short g_out[kSamplesPerFrame * 2];

VBuf* FindBuf(void* p) {
    for (int i = g_nbufs - 1; i >= 0; i--) {
        if (g_bufs[i].alive && (g_bufs[i].ptr == p || g_bufs[i].notify == p)) return &g_bufs[i];
    }
    return nullptr;
}

VBuf* AllocSlot() {
    for (int i = 0; i < g_nbufs; i++) {
        if (!g_bufs[i].alive) return &g_bufs[i];
    }
    if (g_nbufs < kMaxBufs) return &g_bufs[g_nbufs++];
    return nullptr;
}

void RecalcGain(VBuf* b) { virtual_mix::PanHundredthsToGains(b->volume, b->pan, &b->gainL, &b->gainR); }

DWORD PlayBytes(const VBuf* b) {
    DWORD f = (DWORD)b->pos;
    if (f >= b->frames) f = b->frames ? b->frames - 1 : 0;
    return f * b->block;
}

inline void ReadFrame(const VBuf* b, DWORD f, float* l, float* r) {
    const BYTE* p = b->shadow + (size_t)f * b->block;
    if (b->bits == 16) {
        const short* s = (const short*)p;
        *l = s[0] / 32768.0f;
        *r = b->channels >= 2 ? s[1] / 32768.0f : *l;
    } else {
        *l = ((int)p[0] - 128) / 128.0f;
        *r = b->channels >= 2 ? ((int)p[1] - 128) / 128.0f : *l;
    }
}

void FireNotify(VBuf* b, DWORD offset) {
    for (int i = 0; i < b->nnotify; i++) {
        if (b->notifies[i].dwOffset == offset && b->notifies[i].hEventNotify) {
            SetEvent(b->notifies[i].hEventNotify);
            g_notifiesFired++;
        }
    }
}

bool FireCrossed(VBuf* b, DWORD prev, DWORD cur, bool wrapped) {
    bool fired = false;
    for (int i = 0; i < b->nnotify; i++) {
        DWORD o = b->notifies[i].dwOffset;
        if (o == kDSBPN_OFFSETSTOP || !b->notifies[i].hEventNotify) continue;
        if (virtual_mix::CrossedNotifyOffset(o, prev, cur, wrapped)) {
            SetEvent(b->notifies[i].hEventNotify);
            g_notifiesFired++;
            fired = true;
        }
    }
    return fired;
}

HRESULT WINAPI MySetNotify(void* p, DWORD count, const PositionNotify* pos);

HRESULT WINAPI MyQI(void* p, REFIID riid, void** out) {
    HRESULT hr = g_origQI(p, riid, out);
    if (SUCCEEDED(hr) && out && *out && IsEqualGUID(riid, kIID_IDirectSoundNotify)) {
        EnterCriticalSection(&g_cs);
        VBuf* b = FindBuf(p);
        if (b) b->notify = *out;
        vtable::HookObject(*out, 3, &MySetNotify, &g_origSetNotify);
        LeaveCriticalSection(&g_cs);
    }
    return hr;
}

HRESULT WINAPI MySetNotify(void* p, DWORD count, const PositionNotify* pos) {
    EnterCriticalSection(&g_cs);
    VBuf* b = FindBuf(p);
    if (b) {
        b->nnotify = 0;
        for (DWORD i = 0; i < count && i < (DWORD)kMaxNotify; i++) b->notifies[b->nnotify++] = pos[i];
        Log("FrameSyncAudio: buffer %d notify count=%lu first=%lu", b->id, (unsigned long)count,
            count ? (unsigned long)pos[0].dwOffset : 0);
    }
    LeaveCriticalSection(&g_cs);
    return b ? S_OK : g_origSetNotify(p, count, pos);
}

ULONG WINAPI MyRelease(void* p) {
    ULONG r = g_origRelease(p);
    if (r == 0) {
        EnterCriticalSection(&g_cs);
        for (int i = 0; i < g_nbufs; i++) {
            if (g_bufs[i].alive && g_bufs[i].ptr == p) {
                g_bufs[i].alive = false;
                ReleaseShadow(g_bufs[i].sh);
                g_bufs[i].sh = nullptr;
                g_bufs[i].shadow = nullptr;
            }
        }
        LeaveCriticalSection(&g_cs);
    }
    return r;
}

HRESULT WINAPI MyGetPos(void* p, DWORD* play, DWORD* write) {
    EnterCriticalSection(&g_cs);
    VBuf* b = FindBuf(p);
    if (!b) {
        LeaveCriticalSection(&g_cs);
        return g_origGetPos(p, play, write);
    }
    DWORD pb = PlayBytes(b);
    if (play) *play = pb;
    if (write) {
        DWORD lead = (b->freq / 100) * b->block;
        *write = b->bytes ? (pb + lead) % b->bytes : 0;
    }
    LeaveCriticalSection(&g_cs);
    return S_OK;
}

HRESULT WINAPI MyGetStatus(void* p, DWORD* st) {
    EnterCriticalSection(&g_cs);
    VBuf* b = FindBuf(p);
    if (!b) {
        LeaveCriticalSection(&g_cs);
        return g_origGetStatus(p, st);
    }
    if (st) *st = b->playing ? (kDSBSTATUS_PLAYING | (b->looping ? kDSBSTATUS_LOOPING : 0)) : 0;
    LeaveCriticalSection(&g_cs);
    return S_OK;
}

HRESULT WINAPI MyLock(void* p, DWORD off, DWORD bytes, void** a1, DWORD* n1, void** a2,
                      DWORD* n2, DWORD flags) {
    EnterCriticalSection(&g_cs);
    VBuf* b = FindBuf(p);
    if (b) {
        if (flags & kDSBLOCK_ENTIREBUFFER) {
            off = 0;
            bytes = b->bytes;
        } else if (flags & kDSBLOCK_FROMWRITECURSOR) {
            DWORD lead = (b->freq / 100) * b->block;
            off = b->bytes ? (PlayBytes(b) + lead) % b->bytes : 0;
        }
        flags &= ~(kDSBLOCK_ENTIREBUFFER | kDSBLOCK_FROMWRITECURSOR);
        b->lockOff = off;
    }
    LeaveCriticalSection(&g_cs);
    return g_origLock(p, off, bytes, a1, n1, a2, n2, flags);
}

HRESULT WINAPI MyUnlock(void* p, void* a1, DWORD n1, void* a2, DWORD n2) {
    EnterCriticalSection(&g_cs);
    VBuf* b = FindBuf(p);
    if (b && b->shadow) {
        if (a1 && n1 && b->lockOff < b->bytes) {
            DWORD n = n1 < b->bytes - b->lockOff ? n1 : b->bytes - b->lockOff;
            memcpy(b->shadow + b->lockOff, a1, n);
        }
        if (a2 && n2) memcpy(b->shadow, a2, n2 < b->bytes ? n2 : b->bytes);
        InterlockedIncrement(&b->unlockSeq);
    }
    LeaveCriticalSection(&g_cs);
    return g_origUnlock(p, a1, n1, a2, n2);
}

HRESULT WINAPI MyPlay(void* p, DWORD r1, DWORD prio, DWORD flags) {
    EnterCriticalSection(&g_cs);
    VBuf* b = FindBuf(p);
    if (!b && ++g_unknownPlays <= 20) {
        Log("FrameSyncAudio: WARNING Play on unknown buffer %p (not mixed) caller=0x%lX", p,
            (unsigned long)((BYTE*)__builtin_return_address(0) -
                            (BYTE*)GetModuleHandleA(nullptr)));
    }
    if (b) {
        b->playing = true;
        b->looping = (flags & kDSBPLAY_LOOPING) != 0;
        if (b->nnotify) {
            Log("FrameSyncAudio: stream buffer %d Play at mixed_frame=%lld", b->id, g_framesMixed);
        }
    }
    LeaveCriticalSection(&g_cs);
    return b ? S_OK : g_origPlay(p, r1, prio, flags);
}

HRESULT WINAPI MyStop(void* p) {
    EnterCriticalSection(&g_cs);
    VBuf* b = FindBuf(p);
    if (b) {
        if (b->playing) FireNotify(b, kDSBPN_OFFSETSTOP);
        if (b->playing && b->nnotify) {
            Log("FrameSyncAudio: stream buffer %d Stop at mixed_frame=%lld", b->id, g_framesMixed);
        }
        b->playing = false;
    }
    LeaveCriticalSection(&g_cs);
    return b ? S_OK : g_origStop(p);
}

HRESULT WINAPI MySetPos(void* p, DWORD pos) {
    EnterCriticalSection(&g_cs);
    VBuf* b = FindBuf(p);
    if (b && b->block) b->pos = (double)((pos % (b->bytes ? b->bytes : 1)) / b->block);
    LeaveCriticalSection(&g_cs);
    return b ? S_OK : g_origSetPos(p, pos);
}

HRESULT WINAPI MySetVolume(void* p, LONG v) {
    HRESULT hr = g_origSetVolume(p, v);
    EnterCriticalSection(&g_cs);
    VBuf* b = FindBuf(p);
    if (b) {
        b->volume = v < -10000 ? -10000 : (v > 0 ? 0 : v);
        RecalcGain(b);
    }
    LeaveCriticalSection(&g_cs);
    return hr;
}

HRESULT WINAPI MySetPan(void* p, LONG v) {
    HRESULT hr = g_origSetPan(p, v);
    EnterCriticalSection(&g_cs);
    VBuf* b = FindBuf(p);
    if (b) {
        b->pan = v < -10000 ? -10000 : (v > 10000 ? 10000 : v);
        RecalcGain(b);
    }
    LeaveCriticalSection(&g_cs);
    return hr;
}

HRESULT WINAPI MySetFrequency(void* p, DWORD f) {
    HRESULT hr = g_origSetFrequency(p, f);
    EnterCriticalSection(&g_cs);
    VBuf* b = FindBuf(p);
    if (b) b->freq = f ? f : b->rate;
    LeaveCriticalSection(&g_cs);
    return hr;
}

void OnBufferCreated(void* buffer, const void* descPtr, bool isPrimary) {
    if (isPrimary) return;
    const auto* desc = (const DSBufferDescMin*)descPtr;
    if (!desc || !desc->lpwfxFormat) return;
    const auto* wf = (const WaveFormatExMin*)desc->lpwfxFormat;
    if (wf->wFormatTag != 1 || (wf->wBitsPerSample != 8 && wf->wBitsPerSample != 16) ||
        wf->nChannels < 1 || wf->nChannels > 2) {
        Log("FrameSyncAudio: WARNING unsupported format tag=%u bits=%u ch=%u (not mixed)",
            wf->wFormatTag, wf->wBitsPerSample, wf->nChannels);
        return;
    }

    EnterCriticalSection(&g_cs);
    VBuf* slot = AllocSlot();
    if (!slot) {
        LeaveCriticalSection(&g_cs);
        Log("FrameSyncAudio: WARNING too many buffers");
        return;
    }
    VBuf& b = *slot;
    memset(&b, 0, sizeof(b));
    b.ptr = buffer;
    b.alive = true;
    b.id = g_nextId++;
    b.bytes = desc->dwBufferBytes;
    b.rate = b.freq = wf->nSamplesPerSec;
    b.channels = wf->nChannels;
    b.bits = wf->wBitsPerSample;
    b.block = (WORD)(b.channels * b.bits / 8);
    b.frames = b.block ? b.bytes / b.block : 0;
    b.sh = NewShadow(b.bytes, b.bits == 8);
    b.shadow = b.sh->data;
    RecalcGain(&b);

    void** vt = vtable::Of(buffer);
    if (vtable::Hook(vt, 12, &MyPlay, &g_origPlay)) {
        vtable::Hook(vt, 0, &MyQI, &g_origQI);
        vtable::Hook(vt, 2, &MyRelease, &g_origRelease);
        vtable::Hook(vt, 4, &MyGetPos, &g_origGetPos);
        vtable::Hook(vt, 9, &MyGetStatus, &g_origGetStatus);
        vtable::Hook(vt, 11, &MyLock, &g_origLock);
        vtable::Hook(vt, 13, &MySetPos, &g_origSetPos);
        vtable::Hook(vt, 15, &MySetVolume, &g_origSetVolume);
        vtable::Hook(vt, 16, &MySetPan, &g_origSetPan);
        vtable::Hook(vt, 17, &MySetFrequency, &g_origSetFrequency);
        vtable::Hook(vt, 18, &MyStop, &g_origStop);
        vtable::Hook(vt, 19, &MyUnlock, &g_origUnlock);
        Log("FrameSyncAudio: hooked secondary buffer vtable");
    }
    Log("FrameSyncAudio: buffer %d bytes=%lu rate=%lu ch=%u bits=%u flags=0x%lX", b.id,
        (unsigned long)b.bytes, (unsigned long)b.rate, b.channels, b.bits,
        (unsigned long)desc->dwFlags);
    LeaveCriticalSection(&g_cs);
}

void OnBufferDuplicated(void* original, void* dup) {
    EnterCriticalSection(&g_cs);
    VBuf* src = FindBuf(original);
    if (!src || src->ptr != original) {
        LeaveCriticalSection(&g_cs);
        Log("FrameSyncAudio: WARNING duplicate of unknown buffer %p (not mixed)", original);
        return;
    }
    VBuf* slot = AllocSlot();
    if (!slot) {
        LeaveCriticalSection(&g_cs);
        Log("FrameSyncAudio: WARNING too many buffers");
        return;
    }
    VBuf copy = *src;
    VBuf& b = *slot;
    memset(&b, 0, sizeof(b));
    b.ptr = dup;
    b.alive = true;
    b.id = g_nextId++;
    b.bytes = copy.bytes;
    b.rate = copy.rate;
    b.freq = copy.freq;
    b.channels = copy.channels;
    b.bits = copy.bits;
    b.block = copy.block;
    b.frames = copy.frames;
    b.volume = copy.volume;
    b.pan = copy.pan;
    b.sh = copy.sh;
    b.sh->refs++;
    b.shadow = b.sh->data;
    RecalcGain(&b);
    Log("FrameSyncAudio: buffer %d duplicated from %d", b.id, copy.id);
    LeaveCriticalSection(&g_cs);
}

bool MixBuffer(VBuf* b) {
    if (!b->playing || !b->frames) return false;
    double step = (double)b->freq / kOutRate;
    DWORD prevBytes = PlayBytes(b);
    bool wrapped = false;
    float gl = b->gainL, gr = b->gainR;
    bool silent = gl < 1e-5f && gr < 1e-5f;
    for (int i = 0; i < kSamplesPerFrame; i++) {
        if (!silent) {
            DWORD f0 = (DWORD)b->pos;
            float frac = (float)(b->pos - f0);
            DWORD f1 = f0 + 1;
            if (f1 >= b->frames) f1 = b->looping ? 0 : f0;
            float l0, r0, l1, r1;
            ReadFrame(b, f0, &l0, &r0);
            ReadFrame(b, f1, &l1, &r1);
            g_mix[i * 2] += (l0 + (l1 - l0) * frac) * gl;
            g_mix[i * 2 + 1] += (r0 + (r1 - r0) * frac) * gr;
        }
        b->pos += step;
        if (b->pos >= b->frames) {
            if (b->looping) {
                b->pos -= b->frames;
                wrapped = true;
            } else {
                b->pos = 0;
                b->playing = false;
                FireNotify(b, kDSBPN_OFFSETSTOP);
                break;
            }
        }
    }
    if (!b->nnotify) return false;
    DWORD cur = b->playing ? PlayBytes(b) : b->bytes;
    return FireCrossed(b, prevBytes, cur, wrapped);
}

void MixFrame(bool write) {
    if (!g_active) return;
    memset(g_mix, 0, sizeof(g_mix));
    VBuf* waitBuf[8];
    LONG waitSeq[8];
    int nwait = 0;

    EnterCriticalSection(&g_cs);
    for (int i = 0; i < g_nbufs; i++) {
        VBuf* b = &g_bufs[i];
        if (!b->alive) continue;
        LONG seq = b->unlockSeq;
        if (MixBuffer(b) && nwait < 8) {
            waitBuf[nwait] = b;
            waitSeq[nwait] = seq;
            nwait++;
        }
    }
    LeaveCriticalSection(&g_cs);

    for (int i = 0; i < kSamplesPerFrame * 2; i++) {
        g_out[i] = virtual_mix::FloatToS16Clamp(g_mix[i]);
    }
    g_framesMixed++;
    if (write && g_file != INVALID_HANDLE_VALUE) {
        DWORD w = 0;
        if (WriteFile(g_file, g_out, sizeof(g_out), &w, nullptr) && w == sizeof(g_out)) {
            g_framesWritten++;
        } else {
            Log("FrameSyncAudio: ERROR WriteFile failed (%lu)。音声の書き出しを中止します",
                (unsigned long)GetLastError());
            CloseHandle(g_file);
            g_file = INVALID_HANDLE_VALUE;
        }
    }

    for (int i = 0; i < nwait; i++) {
        DWORD start = GetTickCount();
        while (waitBuf[i]->alive && waitBuf[i]->unlockSeq == waitSeq[i]) {
            if (GetTickCount() - start > g_refillWaitMs) {
                g_refillTimeouts++;
                if (g_refillTimeouts <= 20) {
                    Log("FrameSyncAudio: refill wait timeout buffer=%d frame=%lld", waitBuf[i]->id,
                        g_framesMixed);
                }
                break;
            }
            Sleep(0);
        }
    }
}

void Close() {
    if (!g_active) return;
    if (g_file != INVALID_HANDLE_VALUE) CloseHandle(g_file);
    g_file = INVALID_HANDLE_VALUE;
    Log("FrameSyncAudio: closed frames_written=%lld frames_mixed=%lld notifies=%ld "
        "refill_timeouts=%ld unknown_plays=%ld",
        g_framesWritten, g_framesMixed, g_notifiesFired, g_refillTimeouts, g_unknownPlays);
}

}  // namespace

bool Install() {
    const RuntimeConfig& cfg = Config();
    if (!cfg.frameSyncAudio[0]) return false;
    if (g_active) return true;

    g_refillWaitMs = (DWORD)cfg.frameSyncAudioRefillWaitMs;
    InitializeCriticalSection(&g_cs);
    g_file = CreateFileA(cfg.frameSyncAudio, GENERIC_WRITE, FILE_SHARE_READ, nullptr, CREATE_ALWAYS,
                         FILE_ATTRIBUTE_NORMAL, nullptr);
    if (g_file == INVALID_HANDLE_VALUE) {
        Log("FrameSyncAudio: ERROR cannot create %s (%lu)", cfg.frameSyncAudio,
            (unsigned long)GetLastError());
        return false;
    }

    dsound::SetBufferCallbacks(&OnBufferCreated, &OnBufferDuplicated);
    frame_sync::SetAudioHooks({&MixFrame, &Close});
    g_active = true;
    Log("FrameSyncAudio: enabled out=%s rate=%d samples_per_frame=%d refill_wait_ms=%lu",
        cfg.frameSyncAudio, kOutRate, kSamplesPerFrame, (unsigned long)g_refillWaitMs);
    return true;
}

bool Active() { return g_active; }

}  // namespace autoplay::audio::dsound_mixer
