#include "wasapi_hook.h"
#include "logging.h"
#include <stdlib.h>
#include <string.h>

namespace autoplay {

// ABI互換な素の型のみで宣言する(dsound_hook.cpp と同じ方針)。
typedef HRESULT(WINAPI* GetDefaultAudioEndpoint_t)(void*, int, int, void**);
typedef HRESULT(WINAPI* GetDevice_t)(void*, LPCWSTR, void**);
typedef HRESULT(WINAPI* Activate_t)(void*, REFIID, DWORD, void*, void**);
typedef HRESULT(WINAPI* Initialize_t)(void*, int, DWORD, LONGLONG, LONGLONG, const WAVEFORMATEX*,
                                      const GUID*);
typedef HRESULT(WINAPI* IsFormatSupported_t)(void*, int, const WAVEFORMATEX*, WAVEFORMATEX**);
typedef HRESULT(WINAPI* GetMixFormat_t)(void*, WAVEFORMATEX**);
typedef HRESULT(WINAPI* GetService_t)(void*, REFIID, void**);
typedef HRESULT(WINAPI* GetBuffer_t)(void*, UINT32, BYTE**);
typedef HRESULT(WINAPI* ReleaseBuffer_t)(void*, UINT32, DWORD);

static GetDefaultAudioEndpoint_t g_origGetDefaultAudioEndpoint = nullptr;
static GetDevice_t g_origGetDevice = nullptr;
static Activate_t g_origActivate = nullptr;
static Initialize_t g_origInitialize = nullptr;
static IsFormatSupported_t g_origIsFormatSupported = nullptr;
static GetMixFormat_t g_origGetMixFormat = nullptr;
static GetService_t g_origGetService = nullptr;
static GetBuffer_t g_origGetBuffer = nullptr;
static ReleaseBuffer_t g_origReleaseBuffer = nullptr;

static double g_freqScale = 1.0;

// IID_IAudioClient / IAudioClient2 / IAudioClient3 / IAudioRenderClient
static const GUID kIID_IAudioClient = {0x1cb9ad4c, 0xdbfa, 0x4c32, {0xb1, 0x78, 0xc2, 0xf5, 0x68, 0xa7, 0x03, 0xb2}};
static const GUID kIID_IAudioClient2 = {0x726778cd, 0xf60a, 0x4eda, {0x82, 0xde, 0xe4, 0x76, 0x10, 0xcd, 0x78, 0xaa}};
static const GUID kIID_IAudioClient3 = {0x7ed4ee07, 0x8e67, 0x4cd4, {0x8c, 0x1a, 0x2b, 0x7a, 0x59, 0x87, 0xad, 0x42}};
static const GUID kIID_IAudioRenderClient = {0xf294acfc, 0x3146, 0x4483, {0xa7, 0xbf, 0xad, 0xdc, 0xa7, 0xc2, 0x60, 0xe2}};
// KSDATAFORMAT_SUBTYPE_IEEE_FLOAT
static const GUID kSubtypeFloat = {0x00000003, 0x0000, 0x0010, {0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71}};

// 同期マーカー(dsound_hook.cpp と同一の定数)
static const DWORD kSyncMarkerSamples = 131072;
static const short kSyncMarkerAmp = 256;
static const DWORD kSyncMarkerSeed = 0x2545F491u;

// レンダーストリームのフォーマット(ゲームがInitializeに渡したもの)
static WORD g_channels = 0, g_bits = 0, g_blockAlign = 0;
static bool g_isFloat = false;
static DWORD g_streamRate = 0;  // 実ストリームのレート(=ゲームのレート×freqScale)

static BYTE* g_lastBuffer = nullptr;
static volatile LONG g_markerRequested = 0;
static DWORD g_markerPos = 0;  // 注入済みフレーム数
static DWORD g_markerX = kSyncMarkerSeed;
static bool g_markerDone = false;

static void PatchVTable(void** vtable, int index, void* newFunc, void** outOld) {
    if (vtable[index] == newFunc) return;
    DWORD oldProt;
    VirtualProtect(&vtable[index], sizeof(void*), PAGE_EXECUTE_READWRITE, &oldProt);
    if (outOld && !*outOld) *outOld = vtable[index];
    vtable[index] = newFunc;
    VirtualProtect(&vtable[index], sizeof(void*), oldProt, &oldProt);
}

static double EpochNow() {
    FILETIME ft;
    GetSystemTimePreciseAsFileTime(&ft);
    ULONGLONG t = ((ULONGLONG)ft.dwHighDateTime << 32) | ft.dwLowDateTime;
    return (double)(t - 116444736000000000ULL) / 1e7;
}

static size_t FormatSize(const WAVEFORMATEX* f) {
    return sizeof(WAVEFORMATEX) + (f->wFormatTag == WAVE_FORMAT_PCM ? 0 : f->cbSize);
}

static void ScaleRate(WAVEFORMATEX* f, double scale) {
    f->nSamplesPerSec = (DWORD)(f->nSamplesPerSec * scale + 0.5);
    f->nAvgBytesPerSec = f->nSamplesPerSec * f->nBlockAlign;
}

static HRESULT WINAPI MyGetMixFormat(void* self, WAVEFORMATEX** ppFormat) {
    HRESULT hr = g_origGetMixFormat(self, ppFormat);
    if (SUCCEEDED(hr) && ppFormat && *ppFormat && g_freqScale != 1.0) {
        DWORD before = (*ppFormat)->nSamplesPerSec;
        ScaleRate(*ppFormat, 1.0 / g_freqScale);
        Log("WASAPI GetMixFormat: %lu Hz -> ゲームには %lu Hz と見せる", (unsigned long)before,
            (unsigned long)(*ppFormat)->nSamplesPerSec);
    }
    return hr;
}

static HRESULT WINAPI MyIsFormatSupported(void* self, int mode, const WAVEFORMATEX* fmt,
                                          WAVEFORMATEX** closest) {
    if (g_freqScale == 1.0 || !fmt) return g_origIsFormatSupported(self, mode, fmt, closest);
    size_t n = FormatSize(fmt);
    WAVEFORMATEX* copy = (WAVEFORMATEX*)malloc(n);
    memcpy(copy, fmt, n);
    ScaleRate(copy, g_freqScale);
    HRESULT hr = g_origIsFormatSupported(self, mode, copy, closest);
    free(copy);
    if (closest && *closest) ScaleRate(*closest, 1.0 / g_freqScale);
    return hr;
}

static HRESULT WINAPI MyInitialize(void* self, int mode, DWORD flags, LONGLONG dur, LONGLONG period,
                                   const WAVEFORMATEX* fmt, const GUID* session) {
    if (!fmt) return g_origInitialize(self, mode, flags, dur, period, fmt, session);
    size_t n = FormatSize(fmt);
    WAVEFORMATEX* copy = (WAVEFORMATEX*)malloc(n);
    memcpy(copy, fmt, n);
    ScaleRate(copy, g_freqScale);
    HRESULT hr = g_origInitialize(self, mode, flags, dur, period, copy, session);
    // マーカーの書き込みに使うフォーマットは、実際にストリームを開けたときだけ反映する
    // (失敗したフォーマットを残すと、ゲームが別フォーマットで開き直さなかった場合に
    // 食い違った前提で書き込むことになる)。
    if (SUCCEEDED(hr)) {
        g_channels = copy->nChannels;
        g_bits = copy->wBitsPerSample;
        g_blockAlign = copy->nBlockAlign;
        g_streamRate = copy->nSamplesPerSec;
        g_isFloat = copy->wFormatTag == 3 /*WAVE_FORMAT_IEEE_FLOAT*/ ||
                    (copy->wFormatTag == 0xFFFE /*EXTENSIBLE*/ && copy->cbSize >= 22 &&
                     IsEqualGUID(*(const GUID*)((const BYTE*)copy + sizeof(WAVEFORMATEX) + 6), kSubtypeFloat));
    }
    Log("WASAPI Initialize: mode=%d flags=0x%lX game_rate=%lu stream_rate=%lu ch=%u bits=%u float=%d "
        "hr=0x%08lX",
        mode, (unsigned long)flags, (unsigned long)fmt->nSamplesPerSec, (unsigned long)g_streamRate,
        g_channels, g_bits, (int)g_isFloat, (unsigned long)hr);
    free(copy);
    return hr;
}

static HRESULT WINAPI MyGetBuffer(void* self, UINT32 frames, BYTE** data) {
    HRESULT hr = g_origGetBuffer(self, frames, data);
    g_lastBuffer = (SUCCEEDED(hr) && data) ? *data : nullptr;
    return hr;
}

static HRESULT WINAPI MyReleaseBuffer(void* self, UINT32 frames, DWORD flags) {
    if (g_markerRequested && !g_markerDone && g_lastBuffer && frames > 0 &&
        (g_isFloat ? g_bits == 32 : g_bits == 16)) {
        if (flags & 2 /*AUDCLNT_BUFFERFLAGS_SILENT*/) {
            memset(g_lastBuffer, 0, (size_t)frames * g_blockAlign);
            flags &= ~2u;
        }
        double t0 = g_markerPos == 0 ? EpochNow() : 0.0;
        DWORD n = frames;
        if (n > kSyncMarkerSamples - g_markerPos) n = kSyncMarkerSamples - g_markerPos;
        for (DWORD i = 0; i < n; i++) {
            g_markerX ^= g_markerX << 13;
            g_markerX ^= g_markerX >> 17;
            g_markerX ^= g_markerX << 5;
            int v = (g_markerX & 1) ? kSyncMarkerAmp : -kSyncMarkerAmp;
            for (WORD c = 0; c < g_channels; c++) {
                if (g_isFloat) {
                    float* p = (float*)(g_lastBuffer + (size_t)i * g_blockAlign) + c;
                    *p += v / 32768.0f;
                } else {
                    short* p = (short*)(g_lastBuffer + (size_t)i * g_blockAlign) + c;
                    int s = *p + v;
                    *p = (short)(s > 32767 ? 32767 : (s < -32768 ? -32768 : s));
                }
            }
        }
        if (g_markerPos == 0) {
            Log("SYNC_MARKER played epoch=%.6f play_call_sec=%.6f rate=%lu samples=%lu amp=%d "
                "seed=0x%08lX hr=0x00000000",
                t0, 0.0, (unsigned long)g_streamRate, (unsigned long)kSyncMarkerSamples,
                (int)kSyncMarkerAmp, (unsigned long)kSyncMarkerSeed);
        }
        g_markerPos += n;
        if (g_markerPos >= kSyncMarkerSamples) {
            g_markerDone = true;
            Log("SyncMarker(WASAPI): 注入完了");
        }
    }
    HRESULT hr = g_origReleaseBuffer(self, frames, flags);
    // ReleaseBuffer後のバッファは無効。次のGetBufferまで参照しないよう捨てる。
    g_lastBuffer = nullptr;
    return hr;
}

static HRESULT WINAPI MyGetService(void* self, REFIID riid, void** ppv) {
    HRESULT hr = g_origGetService(self, riid, ppv);
    if (SUCCEEDED(hr) && ppv && *ppv && IsEqualGUID(riid, kIID_IAudioRenderClient)) {
        void** vt = *(void***)*ppv;
        PatchVTable(vt, 3, (void*)MyGetBuffer, (void**)&g_origGetBuffer);
        PatchVTable(vt, 4, (void*)MyReleaseBuffer, (void**)&g_origReleaseBuffer);
        Log("WASAPI: hooked IAudioRenderClient GetBuffer/ReleaseBuffer");
    }
    return hr;
}

static HRESULT WINAPI MyActivate(void* self, REFIID riid, DWORD ctx, void* params, void** ppv) {
    HRESULT hr = g_origActivate(self, riid, ctx, params, ppv);
    if (SUCCEEDED(hr) && ppv && *ppv &&
        (IsEqualGUID(riid, kIID_IAudioClient) || IsEqualGUID(riid, kIID_IAudioClient2) ||
         IsEqualGUID(riid, kIID_IAudioClient3))) {
        void** vt = *(void***)*ppv;
        PatchVTable(vt, 3, (void*)MyInitialize, (void**)&g_origInitialize);
        PatchVTable(vt, 7, (void*)MyIsFormatSupported, (void**)&g_origIsFormatSupported);
        PatchVTable(vt, 8, (void*)MyGetMixFormat, (void**)&g_origGetMixFormat);
        PatchVTable(vt, 14, (void*)MyGetService, (void**)&g_origGetService);
        Log("WASAPI: hooked IAudioClient (Initialize/IsFormatSupported/GetMixFormat/GetService)");
    }
    return hr;
}

static void HookDevice(void* dev) {
    if (!dev) return;
    PatchVTable(*(void***)dev, 3, (void*)MyActivate, (void**)&g_origActivate);
}

static HRESULT WINAPI MyGetDefaultAudioEndpoint(void* self, int flow, int role, void** ppDev) {
    HRESULT hr = g_origGetDefaultAudioEndpoint(self, flow, role, ppDev);
    if (SUCCEEDED(hr) && ppDev) HookDevice(*ppDev);
    return hr;
}

static HRESULT WINAPI MyGetDevice(void* self, LPCWSTR id, void** ppDev) {
    HRESULT hr = g_origGetDevice(self, id, ppDev);
    if (SUCCEEDED(hr) && ppDev) HookDevice(*ppDev);
    return hr;
}

void HookMMDeviceEnumerator(void* enumerator) {
    if (!enumerator) return;
    void** vt = *(void***)enumerator;
    PatchVTable(vt, 4, (void*)MyGetDefaultAudioEndpoint, (void**)&g_origGetDefaultAudioEndpoint);
    PatchVTable(vt, 5, (void*)MyGetDevice, (void**)&g_origGetDevice);
    Log("WASAPI: hooked IMMDeviceEnumerator (GetDefaultAudioEndpoint/GetDevice)");
}

static DWORD WINAPI TriggerThread(LPVOID param) {
    const char* path = (const char*)param;
    for (int i = 0; i < 20 * 60 * 200; i++) {
        if (GetFileAttributesA(path) != INVALID_FILE_ATTRIBUTES) {
            Log("SyncMarker(WASAPI): trigger found (%s)", path);
            InterlockedExchange(&g_markerRequested, 1);
            return 0;
        }
        Sleep(5);
    }
    return 0;
}

void InstallWasapiHook(double freqScale) {
    g_freqScale = freqScale;
    const char* env = getenv("FPS_LIMIT_TARGET_HZ");
    if (env && atof(env) > 0.0) g_freqScale = atof(env) / 60.0;
    if (g_freqScale <= 0.0) g_freqScale = 1.0;
    Log("InstallWasapiHook: freqScale=%.4f", g_freqScale);
    const char* trig = getenv("SYNC_MARKER_TRIGGER");
    if (trig && *trig) {
        static char s_path[MAX_PATH];
        lstrcpynA(s_path, trig, MAX_PATH);
        HANDLE th = CreateThread(nullptr, 0, TriggerThread, s_path, 0, nullptr);
        if (th) CloseHandle(th);
        Log("InstallWasapiHook: sync marker armed (trigger=%s)", s_path);
    }
}

} // namespace autoplay
