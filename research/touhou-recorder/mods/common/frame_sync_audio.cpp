// フレーム同期キャプチャの仮想音声デバイス(reports/107)。説明はframe_sync_audio.hを参照。
#include "frame_sync_audio.h"
#include "dsound_probe_hook.h"  // g_dsoundBufferCreatedCallback
#include "logging.h"
#include <math.h>
#include <stdlib.h>
#include <string.h>

namespace autoplay {

namespace {

const int kOutRate = 44100;
const int kSamplesPerFrame = kOutRate / 60;  // 735
const DWORD kDSBPLAY_LOOPING = 0x1;
const DWORD kDSBSTATUS_PLAYING = 0x1, kDSBSTATUS_LOOPING = 0x4;
const DWORD kDSBLOCK_FROMWRITECURSOR = 0x1, kDSBLOCK_ENTIREBUFFER = 0x2;
const DWORD kDSBPN_OFFSETSTOP = 0xFFFFFFFF;

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

QueryInterface_t g_origQI;
Release_t g_origRelease;
GetCurrentPosition_t g_origGetPos;
GetStatus_t g_origGetStatus;
Lock_t g_origLock;
Play_t g_origPlay;
SetCurrentPosition_t g_origSetPos;
SetLong_t g_origSetVolume, g_origSetPan;
SetFrequency_t g_origSetFrequency;
Stop_t g_origStop;
Unlock_t g_origUnlock;
SetNotificationPositions_t g_origSetNotify;

const GUID kIID_IDirectSoundNotify = {0xb0210783, 0x89cd, 0x11d0,
                                      {0xaf, 0x08, 0x00, 0xa0, 0xc9, 0x25, 0xcd, 0x16}};

// バッファの中身の写し。DuplicateSoundBufferの複製は元と同じメモリを共有するので(reports/108)、
// 写しも参照カウントで共有する。
struct Shadow {
    BYTE* data;
    LONG refs;
};

Shadow* NewShadow(DWORD bytes, bool unsigned8) {
    Shadow* sh = (Shadow*)calloc(1, sizeof(Shadow));
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

const int kMaxNotify = 64;
struct VBuf {
    void* ptr;
    void* notify;
    bool alive;
    int id;
    DWORD bytes, rate, freq;
    WORD channels, bits, block;
    DWORD frames;  // バッファのサンプルフレーム数
    Shadow* sh;
    BYTE* shadow;  // == sh->data
    bool playing, looping;
    double pos;  // 再生位置(サンプルフレーム、小数あり)
    LONG volume, pan;
    float gainL, gainR;
    DWORD lockOff;  // 直前のLockのオフセット(Unlockで写しへコピーする位置)
    int nnotify;
    PositionNotify notifies[kMaxNotify];
    volatile LONG unlockSeq;
};

const int kMaxBufs = 512;
VBuf g_bufs[kMaxBufs];
int g_nbufs = 0;
int g_nextId = 0;
CRITICAL_SECTION g_cs;
bool g_active = false;
HANDLE g_file = INVALID_HANDLE_VALUE;
LONGLONG g_framesMixed = 0, g_framesWritten = 0;
LONG g_notifiesFired = 0, g_refillTimeouts = 0;
DWORD g_refillWaitMs = 500;
float g_mix[kSamplesPerFrame * 2];
short g_out[kSamplesPerFrame * 2];

VBuf* FindBuf(void* p) {
    for (int i = g_nbufs - 1; i >= 0; i--)
        if (g_bufs[i].alive && (g_bufs[i].ptr == p || g_bufs[i].notify == p)) return &g_bufs[i];
    return nullptr;
}

void RecalcGain(VBuf* b) {
    float vol = (float)pow(10.0, (double)b->volume / 2000.0);
    float l = vol, r = vol;
    if (b->pan > 0) l *= (float)pow(10.0, -(double)b->pan / 2000.0);
    if (b->pan < 0) r *= (float)pow(10.0, (double)b->pan / 2000.0);
    b->gainL = l;
    b->gainR = r;
}

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

// prev→cur(バイト、ループで折り返すことがある)の間に通知位置があれば発火する。
// 発火したらtrue。
bool FireCrossed(VBuf* b, DWORD prev, DWORD cur, bool wrapped) {
    bool fired = false;
    for (int i = 0; i < b->nnotify; i++) {
        DWORD o = b->notifies[i].dwOffset;
        if (o == kDSBPN_OFFSETSTOP || !b->notifies[i].hEventNotify) continue;
        bool hit = wrapped ? (o > prev || o <= cur) : (o > prev && o <= cur);
        if (hit) {
            SetEvent(b->notifies[i].hEventNotify);
            g_notifiesFired++;
            fired = true;
        }
    }
    return fired;
}

// ---- バッファのメソッド ----
HRESULT WINAPI MySetNotify(void* p, DWORD count, const PositionNotify* pos);

HRESULT WINAPI MyQI(void* p, REFIID riid, void** out) {
    HRESULT hr = g_origQI(p, riid, out);
    if (SUCCEEDED(hr) && out && *out && IsEqualGUID(riid, kIID_IDirectSoundNotify)) {
        EnterCriticalSection(&g_cs);
        VBuf* b = FindBuf(p);
        if (b) b->notify = *out;
        void** vt = *(void***)(*out);
        if (vt[3] != (void*)MySetNotify) {
            g_origSetNotify = (SetNotificationPositions_t)vt[3];
            DWORD old;
            VirtualProtect(&vt[3], sizeof(void*), PAGE_EXECUTE_READWRITE, &old);
            vt[3] = (void*)MySetNotify;
            VirtualProtect(&vt[3], sizeof(void*), old, &old);
        }
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
    // 本物へは渡さない(本物が実時間で通知しないように)。
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
        DWORD lead = (b->freq / 100) * b->block;  // 10ms
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

LONG g_unknownPlays = 0;

HRESULT WINAPI MyPlay(void* p, DWORD r1, DWORD prio, DWORD flags) {
    EnterCriticalSection(&g_cs);
    VBuf* b = FindBuf(p);
    if (!b && ++g_unknownPlays <= 20)
        Log("FrameSyncAudio: WARNING Play on unknown buffer %p (not mixed) caller=0x%lX", p,
            (unsigned long)((BYTE*)__builtin_return_address(0) - (BYTE*)GetModuleHandle(NULL)));
    if (b) {
        b->playing = true;
        b->looping = (flags & kDSBPLAY_LOOPING) != 0;
        if (b->nnotify)
            Log("FrameSyncAudio: stream buffer %d Play at mixed_frame=%lld", b->id, g_framesMixed);
    }
    LeaveCriticalSection(&g_cs);
    return b ? S_OK : g_origPlay(p, r1, prio, flags);
}

HRESULT WINAPI MyStop(void* p) {
    EnterCriticalSection(&g_cs);
    VBuf* b = FindBuf(p);
    if (b) {
        if (b->playing) FireNotify(b, kDSBPN_OFFSETSTOP);
        if (b->playing && b->nnotify)
            Log("FrameSyncAudio: stream buffer %d Stop at mixed_frame=%lld", b->id, g_framesMixed);
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
    if (b) b->freq = f ? f : b->rate;  // 0 = DSBFREQUENCY_ORIGINAL
    LeaveCriticalSection(&g_cs);
    return hr;
}

void PatchSlot(void** vt, int idx, void* fn, void** orig) {
    if (vt[idx] == fn) return;
    *orig = vt[idx];
    DWORD old;
    VirtualProtect(&vt[idx], sizeof(void*), PAGE_EXECUTE_READWRITE, &old);
    vt[idx] = fn;
    VirtualProtect(&vt[idx], sizeof(void*), old, &old);
}

void OnBufferCreated(void* buffer, const void* descPtr, bool isPrimary, void*) {
    if (isPrimary) return;
    const DSBufferDescMin* desc = (const DSBufferDescMin*)descPtr;
    if (!desc || !desc->lpwfxFormat) return;
    const WaveFormatExMin* wf = (const WaveFormatExMin*)desc->lpwfxFormat;
    if (wf->wFormatTag != 1 || (wf->wBitsPerSample != 8 && wf->wBitsPerSample != 16) ||
        wf->nChannels < 1 || wf->nChannels > 2) {
        Log("FrameSyncAudio: WARNING unsupported format tag=%u bits=%u ch=%u (not mixed)",
            wf->wFormatTag, wf->wBitsPerSample, wf->nChannels);
        return;
    }
    EnterCriticalSection(&g_cs);
    // 解放済みの枠を再利用する。
    int slot = -1;
    for (int i = 0; i < g_nbufs; i++)
        if (!g_bufs[i].alive) { slot = i; break; }
    if (slot < 0 && g_nbufs < kMaxBufs) slot = g_nbufs++;
    if (slot < 0) {
        LeaveCriticalSection(&g_cs);
        Log("FrameSyncAudio: WARNING too many buffers");
        return;
    }
    VBuf& b = g_bufs[slot];
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

    void** vt = *(void***)buffer;
    if (vt[12] != (void*)MyPlay) {
        PatchSlot(vt, 0, (void*)MyQI, (void**)&g_origQI);
        PatchSlot(vt, 2, (void*)MyRelease, (void**)&g_origRelease);
        PatchSlot(vt, 4, (void*)MyGetPos, (void**)&g_origGetPos);
        PatchSlot(vt, 9, (void*)MyGetStatus, (void**)&g_origGetStatus);
        PatchSlot(vt, 11, (void*)MyLock, (void**)&g_origLock);
        PatchSlot(vt, 12, (void*)MyPlay, (void**)&g_origPlay);
        PatchSlot(vt, 13, (void*)MySetPos, (void**)&g_origSetPos);
        PatchSlot(vt, 15, (void*)MySetVolume, (void**)&g_origSetVolume);
        PatchSlot(vt, 16, (void*)MySetPan, (void**)&g_origSetPan);
        // [17]はdsound_hookがフック済み。その上に重ねる(倍率1.0なので値は変わらない)。
        PatchSlot(vt, 17, (void*)MySetFrequency, (void**)&g_origSetFrequency);
        PatchSlot(vt, 18, (void*)MyStop, (void**)&g_origStop);
        PatchSlot(vt, 19, (void*)MyUnlock, (void**)&g_origUnlock);
        Log("FrameSyncAudio: hooked secondary buffer vtable");
    }
    Log("FrameSyncAudio: buffer %d bytes=%lu rate=%lu ch=%u bits=%u flags=0x%lX", b.id,
        (unsigned long)b.bytes, (unsigned long)b.rate, b.channels, b.bits,
        (unsigned long)desc->dwFlags);
    LeaveCriticalSection(&g_cs);
}

// DuplicateSoundBufferの複製(reports/108)。中身(写し)を共有し、形式・音量・パン・周波数を
// 元から受け継ぐ(Wineの実装と同じ)。再生位置は0、停止状態から始まる。
void OnBufferDuplicated(void* original, void* dup, void*) {
    EnterCriticalSection(&g_cs);
    VBuf* src = FindBuf(original);
    if (!src || src->ptr != original) {
        LeaveCriticalSection(&g_cs);
        Log("FrameSyncAudio: WARNING duplicate of unknown buffer %p (not mixed)", original);
        return;
    }
    int slot = -1;
    for (int i = 0; i < g_nbufs; i++)
        if (!g_bufs[i].alive) { slot = i; break; }
    if (slot < 0 && g_nbufs < kMaxBufs) slot = g_nbufs++;
    if (slot < 0) {
        LeaveCriticalSection(&g_cs);
        Log("FrameSyncAudio: WARNING too many buffers");
        return;
    }
    src = FindBuf(original);  // g_nbufsの増加で位置は変わらないが念のため引き直す
    VBuf& b = g_bufs[slot];
    VBuf copy = *src;
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

// 1バッファを1フレームぶんミックスする。通知を出したらtrue。
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

}  // namespace

bool FrameSyncAudioActive() { return g_active; }

void FrameSyncAudioMixFrame(bool write) {
    if (!g_active) return;
    memset(g_mix, 0, sizeof(g_mix));
    // 通知を出したバッファと、その時点のUnlock回数(補充を待つため)。
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
        float v = g_mix[i] * 32767.0f;
        if (v > 32767.0f) v = 32767.0f;
        if (v < -32768.0f) v = -32768.0f;
        g_out[i] = (short)lrintf(v);
    }
    g_framesMixed++;
    if (write && g_file != INVALID_HANDLE_VALUE) {
        DWORD w = 0;
        if (WriteFile(g_file, g_out, sizeof(g_out), &w, NULL) && w == sizeof(g_out)) {
            g_framesWritten++;
        } else {
            Log("FrameSyncAudio: ERROR WriteFile failed (%lu)。音声の書き出しを中止します",
                (unsigned long)GetLastError());
            CloseHandle(g_file);
            g_file = INVALID_HANDLE_VALUE;
        }
    }

    // 補充スレッドがUnlockするまで待つ(仮想の再生位置が先へ進む前に)。
    for (int i = 0; i < nwait; i++) {
        DWORD start = GetTickCount();
        while (waitBuf[i]->alive && waitBuf[i]->unlockSeq == waitSeq[i]) {
            if (GetTickCount() - start > g_refillWaitMs) {
                g_refillTimeouts++;
                if (g_refillTimeouts <= 20)
                    Log("FrameSyncAudio: refill wait timeout buffer=%d frame=%lld",
                        waitBuf[i]->id, g_framesMixed);
                break;
            }
            Sleep(0);
        }
    }
}

void FrameSyncAudioClose() {
    if (!g_active) return;
    if (g_file != INVALID_HANDLE_VALUE) CloseHandle(g_file);
    g_file = INVALID_HANDLE_VALUE;
    Log("FrameSyncAudio: closed frames_written=%lld frames_mixed=%lld notifies=%ld "
        "refill_timeouts=%ld unknown_plays=%ld", g_framesWritten, g_framesMixed, g_notifiesFired,
        g_refillTimeouts, g_unknownPlays);
}

bool InstallFrameSyncAudio() {
    const char* path = getenv("FRAME_SYNC_AUDIO");
    if (!path || !path[0]) return false;
    if (const char* v = getenv("FRAME_SYNC_AUDIO_REFILL_WAIT_MS")) g_refillWaitMs = atoi(v);
    InitializeCriticalSection(&g_cs);
    g_file = CreateFileA(path, GENERIC_WRITE, FILE_SHARE_READ, NULL, CREATE_ALWAYS,
                         FILE_ATTRIBUTE_NORMAL, NULL);
    if (g_file == INVALID_HANDLE_VALUE) {
        Log("FrameSyncAudio: ERROR cannot create %s (%lu)", path, (unsigned long)GetLastError());
        return false;
    }
    if (g_dsoundBufferCreatedCallback)
        Log("FrameSyncAudio: WARNING buffer callback already set (DSOUND_PROBE?), overriding");
    g_dsoundBufferCreatedCallback = OnBufferCreated;
    g_dsoundBufferDuplicatedCallback = OnBufferDuplicated;
    g_active = true;
    Log("FrameSyncAudio: enabled out=%s rate=%d samples_per_frame=%d refill_wait_ms=%lu", path,
        kOutRate, kSamplesPerFrame, (unsigned long)g_refillWaitMs);
    return true;
}

} // namespace autoplay
