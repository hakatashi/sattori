// 64bit DXライブラリタイトル(th06c / th06nc)向けのフレーム同期用仮想WASAPI出力。
//
// DirectSound版の frame_sync_audio.cpp に相当するが、DXライブラリはWASAPI (共有モード) の
// GetCurrentPadding + GetBuffer / ReleaseBuffer (またはEVENTCALLBACK) で1つのワーカスレッドが
// ミキシング出力を行う。本モジュールでは仮想リングバッファを持たせ、映像1フレーム (1/60s)
// ごとに 735 サンプル (44100Hz / 2ch / s16le) を取り出して出力PCMへ書き出す。
#include "frame_sync_wasapi.h"

#ifdef _WIN64

#include <math.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <vector>
#include "logging.h"

namespace autoplay {

namespace {

const DWORD kOutRate = 44100;
const int kSamplesPerFrame = kOutRate / 60;  // 735
const DWORD kAUDCLNT_STREAMFLAGS_EVENTCALLBACK = 0x00040000;
const DWORD kAUDCLNT_BUFFERFLAGS_SILENT = 0x2;

const GUID kIID_IAudioClient = {
    0x1cb9ad4c, 0xdbfa, 0x4c32, {0xb1, 0x78, 0xc2, 0xf5, 0x68, 0xa7, 0x03, 0xb2}};
const GUID kIID_IAudioClient2 = {
    0x726778cd, 0xf60a, 0x4eda, {0x82, 0xde, 0xe4, 0x76, 0x10, 0xcd, 0x78, 0xaa}};
const GUID kIID_IAudioClient3 = {
    0x7ed4ee07, 0x8e67, 0x4cd4, {0x8c, 0x1a, 0x2b, 0x7a, 0x59, 0x87, 0xad, 0x42}};
const GUID kIID_IAudioRenderClient = {
    0xf294acfc, 0x3146, 0x4483, {0xa7, 0xbf, 0xad, 0xdc, 0xa7, 0xc2, 0x60, 0xe2}};
const GUID kIID_IAudioClock = {
    0xcd63314f, 0x3fba, 0x4a1b, {0x81, 0x2c, 0xef, 0x96, 0x35, 0x87, 0x28, 0xe7}};
const GUID kSubtypeFloat = {
    0x00000003, 0x0000, 0x0010, {0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71}};

typedef HRESULT(WINAPI* GetDefaultAudioEndpoint_t)(void*, int, int, void**);
typedef HRESULT(WINAPI* GetDevice_t)(void*, LPCWSTR, void**);
typedef HRESULT(WINAPI* Activate_t)(void*, REFIID, DWORD, void*, void**);
typedef HRESULT(WINAPI* Initialize_t)(void*, int, DWORD, LONGLONG, LONGLONG, const WAVEFORMATEX*,
                                      const GUID*);
typedef HRESULT(WINAPI* GetBufferSize_t)(void*, UINT32*);
typedef HRESULT(WINAPI* GetStreamLatency_t)(void*, LONGLONG*);
typedef HRESULT(WINAPI* GetCurrentPadding_t)(void*, UINT32*);
typedef HRESULT(WINAPI* IsFormatSupported_t)(void*, int, const WAVEFORMATEX*, WAVEFORMATEX**);
typedef HRESULT(WINAPI* GetMixFormat_t)(void*, WAVEFORMATEX**);
typedef HRESULT(WINAPI* GetDevicePeriod_t)(void*, LONGLONG*, LONGLONG*);
typedef HRESULT(WINAPI* AudioVoid_t)(void*);
typedef HRESULT(WINAPI* SetEventHandle_t)(void*, HANDLE);
typedef HRESULT(WINAPI* GetService_t)(void*, REFIID, void**);
typedef HRESULT(WINAPI* RenderGetBuffer_t)(void*, UINT32, BYTE**);
typedef HRESULT(WINAPI* RenderReleaseBuffer_t)(void*, UINT32, DWORD);
typedef HRESULT(WINAPI* ClockGetFrequency_t)(void*, UINT64*);
typedef HRESULT(WINAPI* ClockGetPosition_t)(void*, UINT64*, UINT64*);

GetDefaultAudioEndpoint_t g_origGetDefaultAudioEndpoint = nullptr;
GetDevice_t g_origGetDevice = nullptr;
Activate_t g_origActivate = nullptr;
Initialize_t g_origInitialize = nullptr;
GetBufferSize_t g_origGetBufferSize = nullptr;
GetStreamLatency_t g_origGetStreamLatency = nullptr;
GetCurrentPadding_t g_origGetCurrentPadding = nullptr;
IsFormatSupported_t g_origIsFormatSupported = nullptr;
GetMixFormat_t g_origGetMixFormat = nullptr;
GetDevicePeriod_t g_origGetDevicePeriod = nullptr;
AudioVoid_t g_origStart = nullptr;
AudioVoid_t g_origStop = nullptr;
AudioVoid_t g_origReset = nullptr;
SetEventHandle_t g_origSetEventHandle = nullptr;
GetService_t g_origGetService = nullptr;
RenderGetBuffer_t g_origRenderGetBuffer = nullptr;
RenderReleaseBuffer_t g_origRenderReleaseBuffer = nullptr;
ClockGetFrequency_t g_origClockGetFrequency = nullptr;
ClockGetPosition_t g_origClockGetPosition = nullptr;

char g_outPath[MAX_PATH] = {0};
bool g_active = false;
bool g_closed = false;
DWORD g_refillWaitMs = 500;
CRITICAL_SECTION g_cs;
HANDLE g_file = INVALID_HANDLE_VALUE;
HANDLE g_needSamplesEvent = nullptr;
HANDLE g_refilledEvent = nullptr;

void* g_client = nullptr;
void* g_renderClient = nullptr;
void* g_audioClock = nullptr;
volatile DWORD g_wasapiThreadId = 0;

bool g_initialized = false;
bool g_started = false;
bool g_eventMode = false;
HANDLE g_clientEvent = nullptr;

DWORD g_inRate = 44100;
DWORD g_realMixRate = 0;
WORD g_channels = 2;
WORD g_bits = 32;
WORD g_blockAlign = 8;
bool g_isFloat = true;

UINT32 g_bufFrames = 1323;
std::vector<float> g_ring;  // stereo float interleaved [g_bufFrames * 2]
UINT32 g_ringRead = 0;
UINT32 g_ringWrite = 0;
UINT32 g_ringCount = 0;
std::vector<BYTE> g_stageBuf;
UINT32 g_pendingReq = 0;

double g_resamplePhase = 0.0;
float g_lastFrameL = 0.0f, g_lastFrameR = 0.0f;

LONGLONG g_framesMixed = 0;
LONGLONG g_framesWritten = 0;
LONG g_refillCalls = 0;
LONG g_refillTimeouts = 0;
UINT64 g_consumedInFrames = 0;
short g_out[kSamplesPerFrame * 2];

void PatchVTable(void** vt, int idx, void* fn, void** orig) {
    if (vt[idx] == fn) return;
    DWORD old = 0;
    VirtualProtect(&vt[idx], sizeof(void*), PAGE_EXECUTE_READWRITE, &old);
    if (orig && !*orig) *orig = vt[idx];
    vt[idx] = fn;
    VirtualProtect(&vt[idx], sizeof(void*), old, &old);
}

void EnsureOutputFileOpened() {
    if (g_file != INVALID_HANDLE_VALUE || g_closed || !g_outPath[0]) return;
    g_file = CreateFileA(g_outPath, GENERIC_WRITE, FILE_SHARE_READ, NULL, CREATE_ALWAYS,
                         FILE_ATTRIBUTE_NORMAL, NULL);
    if (g_file == INVALID_HANDLE_VALUE) {
        Log("FrameSyncAudio: ERROR cannot create %s (%lu)", g_outPath,
            (unsigned long)GetLastError());
        g_active = false;
    } else {
        Log("FrameSyncAudio: enabled out=%s rate=%lu samples_per_frame=%d refill_wait_ms=%lu "
            "(WASAPI)",
            g_outPath, (unsigned long)kOutRate, kSamplesPerFrame, (unsigned long)g_refillWaitMs);
    }
}

void ConvertSampleToStereoFloat(const BYTE* src, float* l, float* r) {
    if (g_isFloat && g_bits == 32) {
        const float* f = (const float*)src;
        *l = f[0];
        *r = g_channels >= 2 ? f[1] : *l;
    } else if (!g_isFloat && g_bits == 16) {
        const short* s = (const short*)src;
        *l = s[0] / 32768.0f;
        *r = g_channels >= 2 ? s[1] / 32768.0f : *l;
    } else if (!g_isFloat && g_bits == 8) {
        *l = ((int)src[0] - 128) / 128.0f;
        *r = g_channels >= 2 ? ((int)src[1] - 128) / 128.0f : *l;
    } else {
        *l = *r = 0.0f;
    }
}

HRESULT WINAPI MyGetMixFormat(void* self, WAVEFORMATEX** ppFmt) {
    HRESULT hr = g_origGetMixFormat(self, ppFmt);
    if (SUCCEEDED(hr) && ppFmt && *ppFmt) {
        g_realMixRate = (*ppFmt)->nSamplesPerSec;
        if ((*ppFmt)->nSamplesPerSec != kOutRate) {
            DWORD before = (*ppFmt)->nSamplesPerSec;
            (*ppFmt)->nSamplesPerSec = kOutRate;
            (*ppFmt)->nAvgBytesPerSec = kOutRate * (*ppFmt)->nBlockAlign;
            Log("FrameSyncAudio: GetMixFormat %lu Hz -> %lu Hz", (unsigned long)before,
                (unsigned long)kOutRate);
        }
    }
    return hr;
}

HRESULT WINAPI MyIsFormatSupported(void* self, int mode, const WAVEFORMATEX* fmt,
                                   WAVEFORMATEX** closest) {
    return g_origIsFormatSupported(self, mode, fmt, closest);
}

HRESULT WINAPI MyInitialize(void* self, int mode, DWORD flags, LONGLONG dur, LONGLONG period,
                            const WAVEFORMATEX* fmt, const GUID* session) {
    const WAVEFORMATEX* initFmt = fmt;
    BYTE fmtStorage[sizeof(WAVEFORMATEX) + 256];
    if (fmt && g_realMixRate && fmt->nSamplesPerSec != g_realMixRate) {
        size_t extra = (fmt->wFormatTag == WAVE_FORMAT_PCM) ? 0 : fmt->cbSize;
        size_t totalSize = sizeof(WAVEFORMATEX) + extra;
        if (totalSize <= sizeof(fmtStorage)) {
            CopyMemory(fmtStorage, fmt, totalSize);
            WAVEFORMATEX* modFmt = reinterpret_cast<WAVEFORMATEX*>(fmtStorage);
            modFmt->nSamplesPerSec = g_realMixRate;
            modFmt->nAvgBytesPerSec = g_realMixRate * modFmt->nBlockAlign;
            initFmt = modFmt;
            Log("FrameSyncAudio: Initialize real sink rate %lu Hz (game fmt %lu Hz)",
                (unsigned long)g_realMixRate, (unsigned long)fmt->nSamplesPerSec);
        }
    }
    HRESULT hr = g_origInitialize(self, mode, flags, dur, period, initFmt, session);
    if (SUCCEEDED(hr) && fmt) {
        EnsureOutputFileOpened();
        UINT32 realSize = 0;
        if (g_origGetBufferSize) g_origGetBufferSize(self, &realSize);

        EnterCriticalSection(&g_cs);
        g_client = self;
        g_inRate = fmt->nSamplesPerSec ? fmt->nSamplesPerSec : kOutRate;
        g_channels = fmt->nChannels ? fmt->nChannels : 2;
        g_bits = fmt->wBitsPerSample ? fmt->wBitsPerSample : 32;
        g_blockAlign = fmt->nBlockAlign ? fmt->nBlockAlign : (WORD)(g_channels * g_bits / 8);
        g_isFloat =
            (fmt->wFormatTag == 3) ||
            (fmt->wFormatTag == 0xFFFE && fmt->cbSize >= 22 &&
             IsEqualGUID(*(const GUID*)((const BYTE*)fmt + sizeof(WAVEFORMATEX) + 6),
                         kSubtypeFloat));
        g_eventMode = (flags & kAUDCLNT_STREAMFLAGS_EVENTCALLBACK) != 0;

        UINT32 minTwoFrames = (UINT32)((2ULL * g_inRate + 59) / 60);
        g_bufFrames = realSize >= minTwoFrames ? realSize : minTwoFrames;
        // 元のバッファサイズが1フレームより大きい範囲ならそのまま使い、小さいときだけ広げる。
        UINT32 oneFramePlus = (UINT32)((g_inRate + 59) / 60) + 512;
        if (realSize >= oneFramePlus) g_bufFrames = realSize;

        g_ring.assign((size_t)g_bufFrames * 2, 0.0f);
        g_stageBuf.assign((size_t)g_bufFrames * g_blockAlign, 0);
        g_ringRead = g_ringWrite = g_ringCount = 0;
        g_started = false;
        g_initialized = true;
        LeaveCriticalSection(&g_cs);

        Log("FrameSyncAudio: WASAPI Initialize rate=%lu ch=%u bits=%u float=%d flags=0x%lX "
            "real_buf=%u virt_buf=%u",
            (unsigned long)g_inRate, g_channels, g_bits, g_isFloat ? 1 : 0, (unsigned long)flags,
            realSize, g_bufFrames);
    }
    return hr;
}

HRESULT WINAPI MyGetBufferSize(void* self, UINT32* pNumFrames) {
    if (self == g_client && g_initialized && pNumFrames) {
        *pNumFrames = g_bufFrames;
        return S_OK;
    }
    return g_origGetBufferSize(self, pNumFrames);
}

HRESULT WINAPI MyGetStreamLatency(void* self, LONGLONG* pLatency) {
    if (self == g_client && g_initialized && pLatency) {
        *pLatency = (LONGLONG)g_bufFrames * 10000000LL / g_inRate;
        return S_OK;
    }
    return g_origGetStreamLatency(self, pLatency);
}

HRESULT WINAPI MyGetCurrentPadding(void* self, UINT32* pPad) {
    if (self != g_client || !g_initialized) return g_origGetCurrentPadding(self, pPad);
    if (g_started && !g_wasapiThreadId) g_wasapiThreadId = GetCurrentThreadId();
    if (pPad) {
        EnterCriticalSection(&g_cs);
        *pPad = g_ringCount;
        LeaveCriticalSection(&g_cs);
    }
    return S_OK;
}

HRESULT WINAPI MyGetDevicePeriod(void* self, LONGLONG* defPeriod, LONGLONG* minPeriod) {
    return g_origGetDevicePeriod(self, defPeriod, minPeriod);
}

HRESULT WINAPI MyStart(void* self) {
    if (self != g_client || !g_initialized) return g_origStart(self);
    EnterCriticalSection(&g_cs);
    g_started = true;
    LeaveCriticalSection(&g_cs);
    if (g_eventMode && g_clientEvent) SetEvent(g_clientEvent);
    Log("FrameSyncAudio: WASAPI Start (prebuffered=%u frames)", g_ringCount);
    return S_OK;
}

HRESULT WINAPI MyStop(void* self) {
    if (self != g_client || !g_initialized) return g_origStop(self);
    EnterCriticalSection(&g_cs);
    g_started = false;
    LeaveCriticalSection(&g_cs);
    Log("FrameSyncAudio: WASAPI Stop");
    return S_OK;
}

HRESULT WINAPI MyReset(void* self) {
    if (self != g_client || !g_initialized) return g_origReset(self);
    EnterCriticalSection(&g_cs);
    g_ringRead = g_ringWrite = g_ringCount = 0;
    g_started = false;
    LeaveCriticalSection(&g_cs);
    return S_OK;
}

HRESULT WINAPI MySetEventHandle(void* self, HANDLE ev) {
    if (self == g_client) {
        g_clientEvent = ev;
        return S_OK;
    }
    return g_origSetEventHandle(self, ev);
}

HRESULT WINAPI MyRenderGetBuffer(void* self, UINT32 numFrames, BYTE** ppData) {
    if (self != g_renderClient || !g_initialized)
        return g_origRenderGetBuffer(self, numFrames, ppData);
    EnterCriticalSection(&g_cs);
    if (numFrames > g_bufFrames - g_ringCount) {
        LeaveCriticalSection(&g_cs);
        return 0x88890006 /*AUDCLNT_E_BUFFER_TOO_LARGE*/;
    }
    g_pendingReq = numFrames;
    if (g_stageBuf.size() < (size_t)numFrames * g_blockAlign)
        g_stageBuf.resize((size_t)numFrames * g_blockAlign);
    if (ppData) *ppData = g_stageBuf.data();
    LeaveCriticalSection(&g_cs);
    return S_OK;
}

HRESULT WINAPI MyRenderReleaseBuffer(void* self, UINT32 numFrames, DWORD flags) {
    if (self != g_renderClient || !g_initialized)
        return g_origRenderReleaseBuffer(self, numFrames, flags);
    EnterCriticalSection(&g_cs);
    UINT32 n = numFrames;
    if (n > g_bufFrames - g_ringCount) n = g_bufFrames - g_ringCount;
    bool silent = (flags & kAUDCLNT_BUFFERFLAGS_SILENT) != 0;
    for (UINT32 i = 0; i < n; i++) {
        float l = 0.0f, r = 0.0f;
        if (!silent) ConvertSampleToStereoFloat(g_stageBuf.data() + (size_t)i * g_blockAlign, &l, &r);
        g_ring[g_ringWrite * 2] = l;
        g_ring[g_ringWrite * 2 + 1] = r;
        g_ringWrite = (g_ringWrite + 1) % g_bufFrames;
        g_ringCount++;
    }
    g_pendingReq = 0;
    LeaveCriticalSection(&g_cs);
    if (numFrames > 0) {
        InterlockedIncrement(&g_refillCalls);
        if (g_refilledEvent) SetEvent(g_refilledEvent);
    }
    return S_OK;
}

HRESULT WINAPI MyClockGetFrequency(void* self, UINT64* freq) {
    HRESULT hr = g_origClockGetFrequency(self, freq);
    return hr;
}

HRESULT WINAPI MyClockGetPosition(void* self, UINT64* pos, UINT64* qpcPos) {
    if (self == g_audioClock && g_initialized && pos) {
        UINT64 freq = g_inRate;
        if (g_origClockGetFrequency) g_origClockGetFrequency(self, &freq);
        EnterCriticalSection(&g_cs);
        UINT64 c = g_consumedInFrames;
        LeaveCriticalSection(&g_cs);
        *pos = g_inRate ? (c * freq) / g_inRate : 0;
        if (qpcPos) {
            LARGE_INTEGER q;
            QueryPerformanceCounter(&q);
            *qpcPos = (UINT64)q.QuadPart;
        }
        return S_OK;
    }
    return g_origClockGetPosition(self, pos, qpcPos);
}

HRESULT WINAPI MyGetService(void* self, REFIID riid, void** ppv) {
    HRESULT hr = g_origGetService(self, riid, ppv);
    if (SUCCEEDED(hr) && ppv && *ppv) {
        if (IsEqualGUID(riid, kIID_IAudioRenderClient)) {
            g_renderClient = *ppv;
            void** vt = *(void***)*ppv;
            PatchVTable(vt, 3, (void*)MyRenderGetBuffer, (void**)&g_origRenderGetBuffer);
            PatchVTable(vt, 4, (void*)MyRenderReleaseBuffer, (void**)&g_origRenderReleaseBuffer);
        } else if (IsEqualGUID(riid, kIID_IAudioClock)) {
            g_audioClock = *ppv;
            void** vt = *(void***)*ppv;
            PatchVTable(vt, 3, (void*)MyClockGetFrequency, (void**)&g_origClockGetFrequency);
            PatchVTable(vt, 4, (void*)MyClockGetPosition, (void**)&g_origClockGetPosition);
        }
    }
    return hr;
}

HRESULT WINAPI MyActivate(void* self, REFIID riid, DWORD ctx, void* params, void** ppv) {
    HRESULT hr = g_origActivate(self, riid, ctx, params, ppv);
    if (SUCCEEDED(hr) && ppv && *ppv &&
        (IsEqualGUID(riid, kIID_IAudioClient) || IsEqualGUID(riid, kIID_IAudioClient2) ||
         IsEqualGUID(riid, kIID_IAudioClient3))) {
        void** vt = *(void***)*ppv;
        PatchVTable(vt, 3, (void*)MyInitialize, (void**)&g_origInitialize);
        PatchVTable(vt, 4, (void*)MyGetBufferSize, (void**)&g_origGetBufferSize);
        PatchVTable(vt, 5, (void*)MyGetStreamLatency, (void**)&g_origGetStreamLatency);
        PatchVTable(vt, 6, (void*)MyGetCurrentPadding, (void**)&g_origGetCurrentPadding);
        PatchVTable(vt, 7, (void*)MyIsFormatSupported, (void**)&g_origIsFormatSupported);
        PatchVTable(vt, 8, (void*)MyGetMixFormat, (void**)&g_origGetMixFormat);
        PatchVTable(vt, 9, (void*)MyGetDevicePeriod, (void**)&g_origGetDevicePeriod);
        PatchVTable(vt, 10, (void*)MyStart, (void**)&g_origStart);
        PatchVTable(vt, 11, (void*)MyStop, (void**)&g_origStop);
        PatchVTable(vt, 12, (void*)MyReset, (void**)&g_origReset);
        PatchVTable(vt, 13, (void*)MySetEventHandle, (void**)&g_origSetEventHandle);
        PatchVTable(vt, 14, (void*)MyGetService, (void**)&g_origGetService);
    }
    return hr;
}

void HookDevice(void* dev) {
    if (!dev) return;
    PatchVTable(*(void***)dev, 3, (void*)MyActivate, (void**)&g_origActivate);
}

HRESULT WINAPI MyGetDefaultAudioEndpoint(void* self, int flow, int role, void** ppDev) {
    HRESULT hr = g_origGetDefaultAudioEndpoint(self, flow, role, ppDev);
    if (SUCCEEDED(hr) && ppDev) HookDevice(*ppDev);
    return hr;
}

HRESULT WINAPI MyGetDevice(void* self, LPCWSTR id, void** ppDev) {
    HRESULT hr = g_origGetDevice(self, id, ppDev);
    if (SUCCEEDED(hr) && ppDev) HookDevice(*ppDev);
    return hr;
}

void PopOneInFrame(float* l, float* r) {
    if (g_ringCount == 0) {
        *l = g_lastFrameL;
        *r = g_lastFrameR;
        return;
    }
    *l = g_ring[g_ringRead * 2];
    *r = g_ring[g_ringRead * 2 + 1];
    g_lastFrameL = *l;
    g_lastFrameR = *r;
    g_ringRead = (g_ringRead + 1) % g_bufFrames;
    g_ringCount--;
    g_consumedInFrames++;
}

}  // namespace

bool InstallFrameSyncWasapi() {
    const char* path = getenv("FRAME_SYNC_AUDIO");
    if (!path || !path[0]) return false;
    strncpy(g_outPath, path, MAX_PATH - 1);
    if (const char* v = getenv("FRAME_SYNC_AUDIO_REFILL_WAIT_MS")) {
        int w = atoi(v);
        if (w > 0) g_refillWaitMs = (DWORD)w;
    }
    InitializeCriticalSection(&g_cs);
    g_needSamplesEvent = CreateEventA(NULL, FALSE, FALSE, NULL);
    g_refilledEvent = CreateEventA(NULL, FALSE, FALSE, NULL);
    g_active = true;
    return true;
}

bool FrameSyncWasapiActive() { return g_active; }

void HookMMDeviceEnumeratorForFrameSync(void* enumerator) {
    if (!enumerator) return;
    void** vt = *(void***)enumerator;
    PatchVTable(vt, 4, (void*)MyGetDefaultAudioEndpoint, (void**)&g_origGetDefaultAudioEndpoint);
    PatchVTable(vt, 5, (void*)MyGetDevice, (void**)&g_origGetDevice);
}

bool FrameSyncWasapiHandleSleep(DWORD ms) {
    (void)ms;
    if (!g_active || g_closed) return false;
    DWORD tid = GetCurrentThreadId();
    if (!g_wasapiThreadId || tid != g_wasapiThreadId) return false;

    EnterCriticalSection(&g_cs);
    bool needMore = g_started && (g_ringCount < g_bufFrames);
    LeaveCriticalSection(&g_cs);
    if (needMore) return true;  // 即座に返してリフィルさせる

    // 満杯時はFrameSyncWasapiMixFrameからの消費合図を待つ(最大50ms)。
    if (g_needSamplesEvent) WaitForSingleObject(g_needSamplesEvent, 50);
    return true;
}

void FrameSyncWasapiMixFrame(bool write) {
    if (!g_active) return;
    EnsureOutputFileOpened();

    // 入力レートで必要なサンプル数(44100Hz時はちょうど735フレーム)。
    double step = (double)g_inRate / (double)kOutRate;
    UINT32 needed = (UINT32)ceil((kSamplesPerFrame - 1) * step + g_resamplePhase + 1.0);
    if (g_inRate == kOutRate) needed = kSamplesPerFrame;

    if (g_started) {
        DWORD waitStart = GetTickCount();
        for (;;) {
            EnterCriticalSection(&g_cs);
            UINT32 avail = g_ringCount;
            LeaveCriticalSection(&g_cs);
            if (avail >= needed) break;

            if (g_eventMode && g_clientEvent) SetEvent(g_clientEvent);
            if (g_needSamplesEvent) SetEvent(g_needSamplesEvent);

            if (GetTickCount() - waitStart >= g_refillWaitMs) {
                g_refillTimeouts++;
                if (g_refillTimeouts <= 20)
                    Log("FrameSyncAudio: refill wait timeout (WASAPI) frame=%lld have=%u need=%u",
                        g_framesMixed, avail, needed);
                break;
            }
            if (g_refilledEvent) WaitForSingleObject(g_refilledEvent, 20);
            else Sleep(1);
        }
    }

    EnterCriticalSection(&g_cs);
    if (g_inRate == kOutRate) {
        for (int i = 0; i < kSamplesPerFrame; i++) {
            float l = 0.0f, r = 0.0f;
            if (g_started && g_ringCount > 0) PopOneInFrame(&l, &r);
            float lv = l * 32767.0f;
            float rv = r * 32767.0f;
            g_out[i * 2] = (short)(lv > 32767.0f ? 32767 : (lv < -32768.0f ? -32768 : lrintf(lv)));
            g_out[i * 2 + 1] =
                (short)(rv > 32767.0f ? 32767 : (rv < -32768.0f ? -32768 : lrintf(rv)));
        }
    } else {
        // 48000Hz等へのフォールバック: 線形補間リサンプラ
        static float s_curL = 0.0f, s_curR = 0.0f, s_nxtL = 0.0f, s_nxtR = 0.0f;
        static bool s_primed = false;
        if (!s_primed && g_ringCount >= 2) {
            PopOneInFrame(&s_curL, &s_curR);
            PopOneInFrame(&s_nxtL, &s_nxtR);
            s_primed = true;
        }
        for (int i = 0; i < kSamplesPerFrame; i++) {
            float l = 0.0f, r = 0.0f;
            if (g_started && s_primed) {
                float f = (float)g_resamplePhase;
                l = s_curL + (s_nxtL - s_curL) * f;
                r = s_curR + (s_nxtR - s_curR) * f;
                g_resamplePhase += step;
                while (g_resamplePhase >= 1.0) {
                    g_resamplePhase -= 1.0;
                    s_curL = s_nxtL;
                    s_curR = s_nxtR;
                    if (g_ringCount > 0) PopOneInFrame(&s_nxtL, &s_nxtR);
                }
            }
            float lv = l * 32767.0f;
            float rv = r * 32767.0f;
            g_out[i * 2] = (short)(lv > 32767.0f ? 32767 : (lv < -32768.0f ? -32768 : lrintf(lv)));
            g_out[i * 2 + 1] =
                (short)(rv > 32767.0f ? 32767 : (rv < -32768.0f ? -32768 : lrintf(rv)));
        }
    }
    bool needNotify = g_started && (g_ringCount < g_bufFrames);
    LeaveCriticalSection(&g_cs);

    if (needNotify) {
        if (g_eventMode && g_clientEvent) SetEvent(g_clientEvent);
        if (g_needSamplesEvent) SetEvent(g_needSamplesEvent);
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
}

void FrameSyncWasapiClose() {
    if (!g_active) return;
    g_closed = true;
    if (g_needSamplesEvent) SetEvent(g_needSamplesEvent);
    if (g_file != INVALID_HANDLE_VALUE) CloseHandle(g_file);
    g_file = INVALID_HANDLE_VALUE;
    Log("FrameSyncAudio: closed frames_written=%lld frames_mixed=%lld notifies=%ld "
        "refill_timeouts=%ld unknown_plays=0",
        g_framesWritten, g_framesMixed, (long)g_refillCalls, (long)g_refillTimeouts);
}

}  // namespace autoplay

#endif  // _WIN64
