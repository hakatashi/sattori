// 64bit DXライブラリ (D3D11/DXGI) 向けフレーム同期キャプチャ実装。
#include "frame_sync_d3d11.h"

#ifdef _WIN64

#include <d3d11.h>
#include <dxgi1_2.h>
#include <stdlib.h>
#include <string.h>
#include "frame_sync_wasapi.h"
#include "logging.h"

namespace autoplay {

namespace {

inline void** VT(void* obj) { return *(void***)obj; }

const GUID kIID_IDXGIFactory2 = {
    0x50c83a1c, 0xe072, 0x4c48, {0x87, 0xb0, 0x36, 0x30, 0xfa, 0x36, 0xa6, 0xd0}};
const GUID kIID_ID3D11Texture2D = {
    0x6f15aaf2, 0xd208, 0x4e89, {0x9a, 0xb4, 0x48, 0x95, 0x35, 0xd3, 0x4f, 0x9c}};
const GUID kIID_ID3D11Device = {
    0xdb6f6ddb, 0xac77, 0x4e88, {0x82, 0x53, 0x81, 0x9d, 0xf9, 0xbb, 0xf1, 0x40}};

// ---- 仮想時計 & Waitable Timer ----
typedef BOOL(WINAPI* QueryPerformanceCounter_t)(LARGE_INTEGER*);
typedef DWORD(WINAPI* timeGetTime_t)();
typedef DWORD(WINAPI* GetTickCount_t)();
typedef ULONGLONG(WINAPI* GetTickCount64_t)();
typedef void(WINAPI* Sleep_t)(DWORD);
typedef HANDLE(WINAPI* CreateWaitableTimerExW_t)(LPSECURITY_ATTRIBUTES, LPCWSTR, DWORD, DWORD);
typedef HANDLE(WINAPI* CreateWaitableTimerW_t)(LPSECURITY_ATTRIBUTES, BOOL, LPCWSTR);
typedef HANDLE(WINAPI* CreateWaitableTimerA_t)(LPSECURITY_ATTRIBUTES, BOOL, LPCSTR);
typedef BOOL(WINAPI* SetWaitableTimerEx_t)(HANDLE, const LARGE_INTEGER*, LONG, PTIMERAPCROUTINE,
                                           LPVOID, REASON_CONTEXT*, ULONG);
typedef BOOL(WINAPI* SetWaitableTimer_t)(HANDLE, const LARGE_INTEGER*, LONG, PTIMERAPCROUTINE,
                                         LPVOID, BOOL);
typedef DWORD(WINAPI* WaitForSingleObject_t)(HANDLE, DWORD);

QueryPerformanceCounter_t g_origQPC = nullptr;
timeGetTime_t g_origTimeGetTime = nullptr;
GetTickCount_t g_origGetTickCount = nullptr;
GetTickCount64_t g_origGetTickCount64 = nullptr;
Sleep_t g_origSleep = nullptr;
CreateWaitableTimerExW_t g_origCreateWTExW = nullptr;
CreateWaitableTimerW_t g_origCreateWTW = nullptr;
CreateWaitableTimerA_t g_origCreateWTA = nullptr;
SetWaitableTimerEx_t g_origSetWTEx = nullptr;
SetWaitableTimer_t g_origSetWT = nullptr;
WaitForSingleObject_t g_origWFSO = nullptr;

bool g_active = false;
volatile LONG g_virtualMode = 0;
DWORD g_mainThreadId = 0;
CRITICAL_SECTION g_clockCs;
LONGLONG g_freq = 0;
LONGLONG g_vt = 0;
LONGLONG g_vtBase = 0;
DWORD g_tgtBase = 0;
ULONGLONG g_tickBase64 = 0;
LONGLONG g_stepTicks = 0;

const int kMaxTimers = 64;
HANDLE g_timers[kMaxTimers];
int g_nTimers = 0;

void TrackTimer(HANDLE h) {
    if (!h) return;
    EnterCriticalSection(&g_clockCs);
    bool found = false;
    for (int i = 0; i < g_nTimers; i++) {
        if (g_timers[i] == h) {
            found = true;
            break;
        }
    }
    if (!found && g_nTimers < kMaxTimers) g_timers[g_nTimers++] = h;
    LeaveCriticalSection(&g_clockCs);
}

bool IsTrackedTimer(HANDLE h) {
    if (!h) return false;
    EnterCriticalSection(&g_clockCs);
    bool found = false;
    for (int i = 0; i < g_nTimers; i++) {
        if (g_timers[i] == h) {
            found = true;
            break;
        }
    }
    LeaveCriticalSection(&g_clockCs);
    return found;
}

inline bool OnMainThread() { return GetCurrentThreadId() == g_mainThreadId; }

LONGLONG RealNow() {
    LARGE_INTEGER t;
    QueryPerformanceCounter(&t);
    return t.QuadPart;
}

LONGLONG ReadVirtual(LONGLONG advance) {
    EnterCriticalSection(&g_clockCs);
    g_vt += advance;
    LONGLONG v = g_vt;
    LeaveCriticalSection(&g_clockCs);
    return v;
}

void AdvanceVirtualToFrame(LONGLONG frame) {
    EnterCriticalSection(&g_clockCs);
    LONGLONG minVt = g_vtBase + (frame / 60) * g_freq + ((frame % 60) * g_freq) / 60;
    if (g_vt < minVt) g_vt = minVt;
    LeaveCriticalSection(&g_clockCs);
}

void EnterVirtualMode() {
    g_mainThreadId = GetCurrentThreadId();
    g_vt = g_vtBase = RealNow();
    g_tgtBase = timeGetTime();
    g_tickBase64 = GetTickCount64();
    InterlockedExchange(&g_virtualMode, 1);
}

BOOL WINAPI MyQueryPerformanceCounter(LARGE_INTEGER* out) {
    if (!g_virtualMode) return g_origQPC ? g_origQPC(out) : QueryPerformanceCounter(out);
    out->QuadPart = ReadVirtual(OnMainThread() ? g_stepTicks : 0);
    return TRUE;
}

DWORD WINAPI MyTimeGetTime() {
    if (!g_virtualMode) return g_origTimeGetTime ? g_origTimeGetTime() : timeGetTime();
    LONGLONG v = ReadVirtual(OnMainThread() ? g_stepTicks : 0);
    return g_tgtBase + (DWORD)((v - g_vtBase) * 1000 / g_freq);
}

DWORD WINAPI MyGetTickCount() {
    if (!g_virtualMode) return g_origGetTickCount ? g_origGetTickCount() : GetTickCount();
    LONGLONG v = ReadVirtual(OnMainThread() ? g_stepTicks : 0);
    return (DWORD)(g_tickBase64 + (ULONGLONG)((v - g_vtBase) * 1000 / g_freq));
}

ULONGLONG WINAPI MyGetTickCount64() {
    if (!g_virtualMode) return g_origGetTickCount64 ? g_origGetTickCount64() : GetTickCount64();
    LONGLONG v = ReadVirtual(OnMainThread() ? g_stepTicks : 0);
    return g_tickBase64 + (ULONGLONG)((v - g_vtBase) * 1000 / g_freq);
}

void WINAPI MySleep(DWORD ms) {
    if (FrameSyncWasapiHandleSleep(ms)) return;
    if (!g_virtualMode || !OnMainThread()) {
        if (g_origSleep) g_origSleep(ms);
        else Sleep(ms);
        return;
    }
    if (ms > 0 && ms != INFINITE) ReadVirtual((LONGLONG)ms * g_freq / 1000);
    if (g_origSleep) g_origSleep(0);
    else Sleep(0);
}

HANDLE WINAPI MyCreateWaitableTimerExW(LPSECURITY_ATTRIBUTES sa, LPCWSTR name, DWORD flags,
                                       DWORD access) {
    HANDLE h = g_origCreateWTExW(sa, name, flags, access);
    TrackTimer(h);
    return h;
}

HANDLE WINAPI MyCreateWaitableTimerW(LPSECURITY_ATTRIBUTES sa, BOOL manualReset, LPCWSTR name) {
    HANDLE h = g_origCreateWTW(sa, manualReset, name);
    TrackTimer(h);
    return h;
}

HANDLE WINAPI MyCreateWaitableTimerA(LPSECURITY_ATTRIBUTES sa, BOOL manualReset, LPCSTR name) {
    HANDLE h = g_origCreateWTA(sa, manualReset, name);
    TrackTimer(h);
    return h;
}

BOOL WINAPI MySetWaitableTimerEx(HANDLE h, const LARGE_INTEGER* pDue, LONG period,
                                 PTIMERAPCROUTINE comp, LPVOID arg, REASON_CONTEXT* rc,
                                 ULONG tol) {
    TrackTimer(h);
    if (g_virtualMode && OnMainThread()) {
        if (pDue && pDue->QuadPart < 0) {
            LONGLONG ticks = (-pDue->QuadPart) * g_freq / 10000000LL;
            if (ticks > 0) ReadVirtual(ticks);
        }
        return TRUE;
    }
    return g_origSetWTEx(h, pDue, period, comp, arg, rc, tol);
}

BOOL WINAPI MySetWaitableTimer(HANDLE h, const LARGE_INTEGER* pDue, LONG period,
                               PTIMERAPCROUTINE comp, LPVOID arg, BOOL resume) {
    TrackTimer(h);
    if (g_virtualMode && OnMainThread()) {
        if (pDue && pDue->QuadPart < 0) {
            LONGLONG ticks = (-pDue->QuadPart) * g_freq / 10000000LL;
            if (ticks > 0) ReadVirtual(ticks);
        }
        return TRUE;
    }
    return g_origSetWT(h, pDue, period, comp, arg, resume);
}

DWORD WINAPI MyWaitForSingleObject(HANDLE h, DWORD ms) {
    if (g_virtualMode && OnMainThread() && IsTrackedTimer(h)) {
        if (g_origSleep) g_origSleep(0);
        else Sleep(0);
        return WAIT_OBJECT_0;
    }
    return g_origWFSO ? g_origWFSO(h, ms) : WaitForSingleObject(h, ms);
}

// ---- IAT フック ----
bool HookIATEntry(const char* dllName, const char* funcName, void* newFunc, void** outOld) {
    HMODULE hExe = GetModuleHandle(NULL);
    BYTE* base = (BYTE*)hExe;
    auto* dos = (IMAGE_DOS_HEADER*)base;
    auto* nt = (IMAGE_NT_HEADERS*)(base + dos->e_lfanew);
    auto& dir = nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_IMPORT];
    if (dir.VirtualAddress == 0) return false;
    auto* imp = (IMAGE_IMPORT_DESCRIPTOR*)(base + dir.VirtualAddress);

    for (; imp->Name; imp++) {
        if (_stricmp((char*)(base + imp->Name), dllName) != 0) continue;
        auto* thunk = (IMAGE_THUNK_DATA*)(base + imp->FirstThunk);
        auto* ithunk = (IMAGE_THUNK_DATA*)(base + imp->OriginalFirstThunk);
        for (; thunk->u1.Function; thunk++, ithunk++) {
            if (IMAGE_SNAP_BY_ORDINAL(ithunk->u1.Ordinal)) continue;
            auto* byName = (IMAGE_IMPORT_BY_NAME*)(base + ithunk->u1.AddressOfData);
            if (_stricmp((char*)byName->Name, funcName) != 0) continue;
            DWORD oldProt;
            VirtualProtect(&thunk->u1.Function, sizeof(void*), PAGE_EXECUTE_READWRITE, &oldProt);
            if (outOld && (void*)thunk->u1.Function != newFunc)
                *outOld = (void*)thunk->u1.Function;
            thunk->u1.Function = (ULONG_PTR)newFunc;
            VirtualProtect(&thunk->u1.Function, sizeof(void*), oldProt, &oldProt);
            return true;
        }
    }
    return false;
}

void PatchVTable(void* obj, int idx, void* fn, void** orig) {
    void** vt = VT(obj);
    if (vt[idx] == fn) return;
    DWORD old = 0;
    VirtualProtect(&vt[idx], sizeof(void*), PAGE_EXECUTE_READWRITE, &old);
    if (orig && !*orig) *orig = vt[idx];
    vt[idx] = fn;
    VirtualProtect(&vt[idx], sizeof(void*), old, &old);
}

// ---- D3D11 / DXGI 取り込み ----
typedef HRESULT(WINAPI* Present_t)(IDXGISwapChain*, UINT, UINT);
typedef HRESULT(WINAPI* ResizeBuffers_t)(IDXGISwapChain*, UINT, UINT, UINT, DXGI_FORMAT, UINT);
typedef HRESULT(WINAPI* CreateSwapChain_t)(IDXGIFactory*, IUnknown*, DXGI_SWAP_CHAIN_DESC*,
                                           IDXGISwapChain**);
typedef HRESULT(WINAPI* CreateSwapChainForHwnd_t)(IDXGIFactory2*, IUnknown*, HWND,
                                                  const DXGI_SWAP_CHAIN_DESC1*,
                                                  const DXGI_SWAP_CHAIN_FULLSCREEN_DESC*,
                                                  IDXGIOutput*, IDXGISwapChain1**);
typedef HRESULT(WINAPI* D3D11CreateDevice_t)(IDXGIAdapter*, D3D_DRIVER_TYPE, HMODULE, UINT,
                                             const D3D_FEATURE_LEVEL*, UINT, UINT, ID3D11Device**,
                                             D3D_FEATURE_LEVEL*, ID3D11DeviceContext**);
typedef HRESULT(WINAPI* D3D11CreateDeviceAndSwapChain_t)(
    IDXGIAdapter*, D3D_DRIVER_TYPE, HMODULE, UINT, const D3D_FEATURE_LEVEL*, UINT, UINT,
    const DXGI_SWAP_CHAIN_DESC*, IDXGISwapChain**, ID3D11Device**, D3D_FEATURE_LEVEL*,
    ID3D11DeviceContext**);
typedef HRESULT(WINAPI* CreateDXGIFactory_t)(REFIID, void**);
typedef HRESULT(WINAPI* CreateDXGIFactory2_t)(UINT, REFIID, void**);

Present_t g_origPresent = nullptr;
ResizeBuffers_t g_origResizeBuffers = nullptr;
CreateSwapChain_t g_origCreateSwapChain = nullptr;
CreateSwapChainForHwnd_t g_origCreateSwapChainForHwnd = nullptr;
D3D11CreateDevice_t g_origD3D11CreateDevice = nullptr;
D3D11CreateDeviceAndSwapChain_t g_origD3D11CreateDeviceAndSwapChain = nullptr;
CreateDXGIFactory_t g_origCreateDXGIFactory = nullptr;
CreateDXGIFactory_t g_origCreateDXGIFactory1 = nullptr;
CreateDXGIFactory2_t g_origCreateDXGIFactory2 = nullptr;

char g_pipePath[MAX_PATH] = {0};
char g_stopPath[MAX_PATH] = {0};
HANDLE g_pipe = INVALID_HANDLE_VALUE;
bool g_captureDone = false;
volatile LONG g_unthrottled = 0;
bool g_pipeline = true;
bool g_skipPresent = false;
int g_stepDiv = 64;

IDXGISwapChain* g_capSc = nullptr;
ID3D11Device* g_dev = nullptr;
ID3D11DeviceContext* g_ctx = nullptr;
ID3D11Texture2D* g_staging[2] = {nullptr, nullptr};
int g_pendingIdx = -1;
UINT g_capW = 0, g_capH = 0;
DXGI_FORMAT g_capFmt = DXGI_FORMAT_UNKNOWN;
bool g_loggedCaptureStart = false;
bool g_loggedInitSummary = false;

LONGLONG g_presentCount = 0;
volatile LONG g_presentCount32 = 0;
LONGLONG g_framesWritten = 0;
const int kStatsEvery = 600;
LONGLONG g_statReadback = 0, g_statWrite = 0, g_statPresent = 0, g_statGame = 0, g_statAudio = 0;
LONGLONG g_statWindowStart = 0, g_statWindowStartFrame = 0;
LONGLONG g_prePresentEnd = 0, g_postPresentEnd = 0;
LONGLONG g_lastThrottleNow = 0;

const char* DxgiPixFmtName(DXGI_FORMAT fmt) {
    switch (fmt) {
        case DXGI_FORMAT_R8G8B8A8_UNORM:
        case DXGI_FORMAT_R8G8B8A8_UNORM_SRGB:
            return "rgb0";
        case DXGI_FORMAT_B8G8R8A8_UNORM:
        case DXGI_FORMAT_B8G8R8X8_UNORM:
        case DXGI_FORMAT_B8G8R8A8_UNORM_SRGB:
            return "bgr0";
        default:
            return nullptr;
    }
}

void GiveUpCapture(const char* why, HRESULT hr) {
    Log("FrameSync: ERROR %s (hr=0x%08lX)。取り込みを中止します", why, (unsigned long)hr);
    if (g_pipe != INVALID_HANDLE_VALUE) CloseHandle(g_pipe);
    g_pipe = INVALID_HANDLE_VALUE;
    g_captureDone = true;
    FrameSyncWasapiClose();
}

bool WriteAll(const BYTE* p, DWORD size) {
    while (size > 0) {
        DWORD written = 0;
        if (!WriteFile(g_pipe, p, size, &written, NULL)) return false;
        p += written;
        size -= written;
    }
    return true;
}

bool WriteStaging(ID3D11Texture2D* tex) {
    LONGLONG t0 = RealNow();
    D3D11_MAPPED_SUBRESOURCE mapped = {};
    HRESULT hr = g_ctx->Map(tex, 0, D3D11_MAP_READ, 0, &mapped);
    if (FAILED(hr) || !mapped.pData) {
        GiveUpCapture("ID3D11DeviceContext::Map failed", hr);
        return false;
    }
    LONGLONG t1 = RealNow();
    const BYTE* bits = (const BYTE*)mapped.pData;
    UINT rowBytes = g_capW * 4;
    bool ok = true;
    if (mapped.RowPitch == rowBytes) {
        ok = WriteAll(bits, rowBytes * g_capH);
    } else {
        for (UINT y = 0; y < g_capH && ok; y++)
            ok = WriteAll(bits + (size_t)y * mapped.RowPitch, rowBytes);
    }
    DWORD err = ok ? 0 : GetLastError();
    g_ctx->Unmap(tex, 0);
    if (!ok) {
        GiveUpCapture("WriteFile to pipe failed", (HRESULT)err);
        return false;
    }
    g_statReadback += t1 - t0;
    g_statWrite += RealNow() - t1;
    g_framesWritten++;
    return true;
}

void FlushPending() {
    if (g_pendingIdx < 0 || !g_staging[g_pendingIdx]) return;
    int idx = g_pendingIdx;
    g_pendingIdx = -1;
    WriteStaging(g_staging[idx]);
}

void ReleaseCaptureResources() {
    FlushPending();
    for (int i = 0; i < 2; i++) {
        if (g_staging[i]) {
            g_staging[i]->Release();
            g_staging[i] = nullptr;
        }
    }
    if (g_ctx) {
        g_ctx->Release();
        g_ctx = nullptr;
    }
    if (g_dev) {
        g_dev->Release();
        g_dev = nullptr;
    }
    g_capSc = nullptr;
}

void StopCapture() {
    FlushPending();
    if (g_pipe != INVALID_HANDLE_VALUE) CloseHandle(g_pipe);
    g_pipe = INVALID_HANDLE_VALUE;
    g_captureDone = true;
    InterlockedExchange(&g_unthrottled, 0);
    Log("FrameSync: capture stopped frames_written=%lld present_count=%lld "
        "frames_with_live_threads=0 throttle_while_threads=0",
        g_framesWritten, g_presentCount);
    FrameSyncWasapiClose();
}

void CaptureFrameD3D11(IDXGISwapChain* sc) {
    if (g_capSc && g_capSc != sc) {
        Log("FrameSync: swapchain changed (%p -> %p), recreating staging", g_capSc, sc);
        ReleaseCaptureResources();
    }
    LONGLONG t0 = RealNow();
    ID3D11Texture2D* bb = nullptr;
    HRESULT hr = sc->GetBuffer(0, kIID_ID3D11Texture2D, (void**)&bb);
    if (FAILED(hr) || !bb) return GiveUpCapture("IDXGISwapChain::GetBuffer failed", hr);

    D3D11_TEXTURE2D_DESC bd = {};
    bb->GetDesc(&bd);
    if (!g_staging[0]) {
        const char* pix = DxgiPixFmtName(bd.Format);
        if (!pix) {
            bb->Release();
            return GiveUpCapture("unsupported DXGI backbuffer format", (HRESULT)bd.Format);
        }
        hr = sc->GetDevice(kIID_ID3D11Device, (void**)&g_dev);
        if (FAILED(hr) || !g_dev) {
            bb->Release();
            return GiveUpCapture("IDXGISwapChain::GetDevice failed", hr);
        }
        g_dev->GetImmediateContext(&g_ctx);
        if (!g_ctx) {
            bb->Release();
            return GiveUpCapture("GetImmediateContext failed", E_FAIL);
        }
        D3D11_TEXTURE2D_DESC sd = {};
        sd.Width = bd.Width;
        sd.Height = bd.Height;
        sd.MipLevels = 1;
        sd.ArraySize = 1;
        sd.Format = bd.Format;
        sd.SampleDesc.Count = 1;
        sd.SampleDesc.Quality = 0;
        sd.Usage = D3D11_USAGE_STAGING;
        sd.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
        for (int i = 0; i < (g_pipeline ? 2 : 1); i++) {
            hr = g_dev->CreateTexture2D(&sd, nullptr, &g_staging[i]);
            if (FAILED(hr) || !g_staging[i]) {
                bb->Release();
                return GiveUpCapture("CreateTexture2D(staging) failed", hr);
            }
        }
        g_capSc = sc;
        g_capW = bd.Width;
        g_capH = bd.Height;
        g_capFmt = bd.Format;
        if (!g_loggedCaptureStart) {
            g_loggedCaptureStart = true;
            Log("FrameSync: capture start width=%u height=%u d3dfmt=%lu pix_fmt=%s "
                "multisample=%lu",
                g_capW, g_capH, (unsigned long)bd.Format, pix,
                (unsigned long)bd.SampleDesc.Count);
        } else {
            Log("FrameSync: recreated staging width=%u height=%u d3dfmt=%lu pix_fmt=%s",
                g_capW, g_capH, (unsigned long)bd.Format, pix);
        }
    } else if (bd.Width != g_capW || bd.Height != g_capH || bd.Format != g_capFmt) {
        bb->Release();
        return GiveUpCapture("backbuffer size/format changed", (HRESULT)bd.Format);
    }

    if (g_pipeline) {
        int cur = (int)(g_presentCount & 1);
        g_ctx->CopyResource(g_staging[cur], bb);
        bb->Release();
        int prev = g_pendingIdx;
        g_pendingIdx = cur;
        g_statReadback += RealNow() - t0;
        if (prev >= 0) WriteStaging(g_staging[prev]);
        return;
    }

    g_ctx->CopyResource(g_staging[0], bb);
    bb->Release();
    g_statReadback += RealNow() - t0;
    WriteStaging(g_staging[0]);
}

HRESULT WINAPI MyPresent(IDXGISwapChain* sc, UINT sync, UINT flags) {
    LONGLONG entry = RealNow();
    if (!g_loggedInitSummary) {
        g_loggedInitSummary = true;
        Log("InstallFrameSyncHook (D3D11): active=1 step_div=%d pipeline=%d skip_present=%d "
            "pipe=%s",
            g_stepDiv, g_pipeline ? 1 : 0, g_skipPresent ? 1 : 0, g_pipePath);
    }
    if (!g_virtualMode) {
        EnterVirtualMode();
        g_statWindowStart = entry;
        Log("FrameSync: virtual clock on (main thread id=%lu, step=%lld ticks, freq=%lld)",
            (unsigned long)g_mainThreadId, g_stepTicks, g_freq);
    }
    if (g_postPresentEnd) g_statGame += entry - g_postPresentEnd;
    g_presentCount++;
    InterlockedIncrement(&g_presentCount32);

    bool captured = false;
    if (!g_captureDone) {
        if (g_pipe == INVALID_HANDLE_VALUE) {
            g_pipe = CreateFileA(g_pipePath, GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
                                 NULL, OPEN_EXISTING, 0, NULL);
            if (g_pipe == INVALID_HANDLE_VALUE)
                GiveUpCapture("cannot open FRAME_SYNC_PIPE", (HRESULT)GetLastError());
        }
        if (g_pipe != INVALID_HANDLE_VALUE) {
            if (g_stopPath[0] && (g_presentCount & 7) == 0 &&
                GetFileAttributesA(g_stopPath) != INVALID_FILE_ATTRIBUTES) {
                StopCapture();
            } else {
                CaptureFrameD3D11(sc);
                captured = !g_captureDone;
            }
        }
    }

    if (FrameSyncWasapiActive()) {
        LONGLONG a0 = RealNow();
        FrameSyncWasapiMixFrame(captured);
        g_statAudio += RealNow() - a0;
    }

    if (g_presentCount - g_statWindowStartFrame >= kStatsEvery) {
        LONGLONG now = RealNow();
        double n = (double)(g_presentCount - g_statWindowStartFrame);
        double toMs = 1000.0 / (double)g_freq;
        double realMs = (double)(now - g_statWindowStart) * toMs;
        Log("FrameSync: stats frame=%lld written=%lld real_ms=%.0f fps=%.1f "
            "game_ms=%.3f readback_ms=%.3f write_ms=%.3f present_ms=%.3f unthrottled=%ld "
            "readback2_ms=0.000 audio_ms=%.3f",
            g_presentCount, g_framesWritten, realMs, n * 1000.0 / realMs,
            (double)g_statGame * toMs / n, (double)g_statReadback * toMs / n,
            (double)g_statWrite * toMs / n, (double)g_statPresent * toMs / n,
            (long)g_unthrottled, (double)g_statAudio * toMs / n);
        g_statGame = g_statReadback = g_statWrite = g_statPresent = g_statAudio = 0;
        g_statWindowStart = now;
        g_statWindowStartFrame = g_presentCount;
    }

    g_prePresentEnd = RealNow();
    if (!g_unthrottled && g_lastThrottleNow) {
        double targetSec = 1.0 / 60.0;
        double elapsed = (double)(g_prePresentEnd - g_lastThrottleNow) / (double)g_freq;
        double rem = targetSec - elapsed;
        if (rem > 0.0) {
            DWORD ms = (DWORD)(rem * 1000.0);
            if (ms > 0) Sleep(ms);
            while ((double)(RealNow() - g_lastThrottleNow) / (double)g_freq < targetSec) {
            }
        }
    }

    HRESULT hr = S_OK;
    if (!(g_unthrottled && g_skipPresent)) {
        hr = g_origPresent(sc, g_unthrottled ? 0 : sync, flags);
    }
    g_lastThrottleNow = RealNow();
    if (g_virtualMode) AdvanceVirtualToFrame(g_presentCount);
    g_postPresentEnd = RealNow();
    g_statPresent += g_postPresentEnd - g_prePresentEnd;
    return hr;
}

HRESULT WINAPI MyResizeBuffers(IDXGISwapChain* sc, UINT cnt, UINT w, UINT h, DXGI_FORMAT fmt,
                                 UINT flags) {
    if (sc == g_capSc) {
        Log("FrameSync: ResizeBuffers (%ux%u fmt=%d), resetting staging", w, h, (int)fmt);
        ReleaseCaptureResources();
    }
    return g_origResizeBuffers(sc, cnt, w, h, fmt, flags);
}

void HookSwapChain(IDXGISwapChain* sc) {
    if (!sc) return;
    PatchVTable(sc, 8, (void*)MyPresent, (void**)&g_origPresent);
    PatchVTable(sc, 13, (void*)MyResizeBuffers, (void**)&g_origResizeBuffers);
}

HRESULT WINAPI MyCreateSwapChain(IDXGIFactory* fac, IUnknown* dev, DXGI_SWAP_CHAIN_DESC* desc,
                                 IDXGISwapChain** ppSc) {
    HRESULT hr = g_origCreateSwapChain(fac, dev, desc, ppSc);
    if (SUCCEEDED(hr) && ppSc && *ppSc) HookSwapChain(*ppSc);
    return hr;
}

HRESULT WINAPI MyCreateSwapChainForHwnd(IDXGIFactory2* fac, IUnknown* dev, HWND hwnd,
                                        const DXGI_SWAP_CHAIN_DESC1* desc,
                                        const DXGI_SWAP_CHAIN_FULLSCREEN_DESC* fsDesc,
                                        IDXGIOutput* out, IDXGISwapChain1** ppSc) {
    HRESULT hr = g_origCreateSwapChainForHwnd(fac, dev, hwnd, desc, fsDesc, out, ppSc);
    if (SUCCEEDED(hr) && ppSc && *ppSc) HookSwapChain(*ppSc);
    return hr;
}

void HookFactory(void* fac) {
    if (!fac) return;
    PatchVTable(fac, 10, (void*)MyCreateSwapChain, (void**)&g_origCreateSwapChain);
    void* f2 = nullptr;
    if (SUCCEEDED(((IUnknown*)fac)->QueryInterface(kIID_IDXGIFactory2, &f2)) && f2) {
        PatchVTable(f2, 15, (void*)MyCreateSwapChainForHwnd,
                    (void**)&g_origCreateSwapChainForHwnd);
        ((IUnknown*)f2)->Release();
    }
}

HRESULT WINAPI MyD3D11CreateDevice(IDXGIAdapter* a, D3D_DRIVER_TYPE t, HMODULE m, UINT f,
                                   const D3D_FEATURE_LEVEL* l, UINT n, UINT v, ID3D11Device** d,
                                   D3D_FEATURE_LEVEL* fl, ID3D11DeviceContext** c) {
    return g_origD3D11CreateDevice(a, t, m, f, l, n, v, d, fl, c);
}

HRESULT WINAPI MyD3D11CreateDeviceAndSwapChain(
    IDXGIAdapter* a, D3D_DRIVER_TYPE t, HMODULE m, UINT f, const D3D_FEATURE_LEVEL* l, UINT n,
    UINT v, const DXGI_SWAP_CHAIN_DESC* sd, IDXGISwapChain** sc, ID3D11Device** d,
    D3D_FEATURE_LEVEL* fl, ID3D11DeviceContext** c) {
    HRESULT hr =
        g_origD3D11CreateDeviceAndSwapChain(a, t, m, f, l, n, v, sd, sc, d, fl, c);
    if (SUCCEEDED(hr) && sc && *sc) HookSwapChain(*sc);
    return hr;
}

HRESULT WINAPI MyCreateDXGIFactory(REFIID riid, void** ppv) {
    HRESULT hr = g_origCreateDXGIFactory(riid, ppv);
    if (SUCCEEDED(hr) && ppv && *ppv) HookFactory(*ppv);
    return hr;
}

HRESULT WINAPI MyCreateDXGIFactory1(REFIID riid, void** ppv) {
    HRESULT hr = g_origCreateDXGIFactory1(riid, ppv);
    if (SUCCEEDED(hr) && ppv && *ppv) HookFactory(*ppv);
    return hr;
}

HRESULT WINAPI MyCreateDXGIFactory2(UINT flags, REFIID riid, void** ppv) {
    HRESULT hr = g_origCreateDXGIFactory2(flags, riid, ppv);
    if (SUCCEEDED(hr) && ppv && *ppv) HookFactory(*ppv);
    return hr;
}

}  // namespace

bool InstallFrameSyncD3D11(int stepDiv) {
    const char* pipe = getenv("FRAME_SYNC_PIPE");
    if (!pipe || !pipe[0]) return false;
    strncpy(g_pipePath, pipe, MAX_PATH - 1);
    if (const char* stop = getenv("FRAME_SYNC_STOP")) strncpy(g_stopPath, stop, MAX_PATH - 1);
    if (const char* v = getenv("FRAME_SYNC_STEP_DIV")) {
        int d = atoi(v);
        if (d > 0) stepDiv = d;
    }
    if (stepDiv < 1) stepDiv = 1;
    g_stepDiv = stepDiv;
    if (const char* v = getenv("FRAME_SYNC_PIPELINE")) g_pipeline = atoi(v) != 0;
    if (const char* v = getenv("FRAME_SYNC_SKIP_PRESENT")) g_skipPresent = atoi(v) != 0;

    InitializeCriticalSection(&g_clockCs);
    LARGE_INTEGER f;
    QueryPerformanceFrequency(&f);
    g_freq = f.QuadPart;
    g_stepTicks = g_freq / 60 / g_stepDiv;
    if (g_stepTicks < 1) g_stepTicks = 1;

    HookIATEntry("KERNEL32.dll", "QueryPerformanceCounter", (void*)MyQueryPerformanceCounter,
                 (void**)&g_origQPC);
    HookIATEntry("WINMM.dll", "timeGetTime", (void*)MyTimeGetTime, (void**)&g_origTimeGetTime);
    HookIATEntry("KERNEL32.dll", "GetTickCount", (void*)MyGetTickCount,
                 (void**)&g_origGetTickCount);
    HookIATEntry("KERNEL32.dll", "GetTickCount64", (void*)MyGetTickCount64,
                 (void**)&g_origGetTickCount64);
    HookIATEntry("KERNEL32.dll", "Sleep", (void*)MySleep, (void**)&g_origSleep);
    HookIATEntry("KERNEL32.dll", "CreateWaitableTimerExW", (void*)MyCreateWaitableTimerExW,
                 (void**)&g_origCreateWTExW);
    HookIATEntry("KERNEL32.dll", "CreateWaitableTimerW", (void*)MyCreateWaitableTimerW,
                 (void**)&g_origCreateWTW);
    HookIATEntry("KERNEL32.dll", "CreateWaitableTimerA", (void*)MyCreateWaitableTimerA,
                 (void**)&g_origCreateWTA);
    HookIATEntry("KERNEL32.dll", "SetWaitableTimerEx", (void*)MySetWaitableTimerEx,
                 (void**)&g_origSetWTEx);
    HookIATEntry("KERNEL32.dll", "SetWaitableTimer", (void*)MySetWaitableTimer,
                 (void**)&g_origSetWT);
    HookIATEntry("KERNEL32.dll", "WaitForSingleObject", (void*)MyWaitForSingleObject,
                 (void**)&g_origWFSO);

    InstallFrameSyncWasapi();
    g_active = true;
    return true;
}

bool FrameSyncD3D11Active() { return g_active; }

void FrameSyncD3D11SetUnthrottled(bool unthrottled) {
    if (!g_active) return;
    if (unthrottled && g_captureDone) return;
    InterlockedExchange(&g_unthrottled, unthrottled ? 1 : 0);
    Log("FrameSync: unthrottled=%d at frame=%lld", unthrottled ? 1 : 0, g_presentCount);
}

void FrameSyncD3D11SleepMs(DWORD ms) {
    if (!g_active) {
        Sleep(ms);
        return;
    }
    const DWORD kTimeoutMs = 300000;
    LONGLONG targetFrames = ((LONGLONG)ms * 60 + 999) / 1000;
    LONG startFrame = InterlockedCompareExchange(&g_presentCount32, 0, 0);
    DWORD realStart = GetTickCount();
    while ((LONGLONG)(InterlockedCompareExchange(&g_presentCount32, 0, 0) - startFrame) <
           targetFrames) {
        if (GetTickCount() - realStart >= kTimeoutMs) {
            Log("FrameSyncD3D11SleepMs: TIMEOUT waiting %lld frames (ms=%lu)", targetFrames,
                (unsigned long)ms);
            return;
        }
        Sleep(2);
    }
}

void FrameSyncD3D11WaitPresentFrames(int frames) {
    if (!g_active || frames <= 0) return;
    const DWORD kTimeoutMs = 300000;
    LONG startFrame = InterlockedCompareExchange(&g_presentCount32, 0, 0);
    DWORD realStart = GetTickCount();
    while ((InterlockedCompareExchange(&g_presentCount32, 0, 0) - startFrame) < frames) {
        if (GetTickCount() - realStart >= kTimeoutMs) {
            Log("FrameSyncD3D11WaitPresentFrames: TIMEOUT waiting %d frames", frames);
            return;
        }
        Sleep(2);
    }
}

void* WrapQPCForFrameSync(void* real) {
    if (!g_active || !real) return real;
    if (!g_origQPC && real != (void*)MyQueryPerformanceCounter)
        g_origQPC = (QueryPerformanceCounter_t)real;
    return (void*)MyQueryPerformanceCounter;
}

void* WrapTimeGetTimeForFrameSync(void* real) {
    if (!g_active || !real) return real;
    if (!g_origTimeGetTime && real != (void*)MyTimeGetTime) g_origTimeGetTime = (timeGetTime_t)real;
    return (void*)MyTimeGetTime;
}

void* WrapGetTickCountForFrameSync(void* real) {
    if (!g_active || !real) return real;
    if (!g_origGetTickCount && real != (void*)MyGetTickCount)
        g_origGetTickCount = (GetTickCount_t)real;
    return (void*)MyGetTickCount;
}

void* WrapGetTickCount64ForFrameSync(void* real) {
    if (!g_active || !real) return real;
    if (!g_origGetTickCount64 && real != (void*)MyGetTickCount64)
        g_origGetTickCount64 = (GetTickCount64_t)real;
    return (void*)MyGetTickCount64;
}

void* WrapSleepForFrameSync(void* real) {
    if (!g_active || !real) return real;
    if (!g_origSleep && real != (void*)MySleep) g_origSleep = (Sleep_t)real;
    return (void*)MySleep;
}

void* WrapWaitForSingleObjectForFrameSync(void* real) {
    if (!g_active || !real) return real;
    if (!g_origWFSO && real != (void*)MyWaitForSingleObject)
        g_origWFSO = (WaitForSingleObject_t)real;
    return (void*)MyWaitForSingleObject;
}

void* WrapD3D11CreateDeviceForFrameSync(void* real) {
    if (!g_active || !real) return real;
    if (!g_origD3D11CreateDevice && real != (void*)MyD3D11CreateDevice)
        g_origD3D11CreateDevice = (D3D11CreateDevice_t)real;
    return (void*)MyD3D11CreateDevice;
}

void* WrapD3D11CreateDeviceAndSwapChainForFrameSync(void* real) {
    if (!g_active || !real) return real;
    if (!g_origD3D11CreateDeviceAndSwapChain && real != (void*)MyD3D11CreateDeviceAndSwapChain)
        g_origD3D11CreateDeviceAndSwapChain = (D3D11CreateDeviceAndSwapChain_t)real;
    return (void*)MyD3D11CreateDeviceAndSwapChain;
}

void* WrapCreateDXGIFactoryForFrameSync(void* real) {
    if (!g_active || !real) return real;
    if (!g_origCreateDXGIFactory && real != (void*)MyCreateDXGIFactory)
        g_origCreateDXGIFactory = (CreateDXGIFactory_t)real;
    return (void*)MyCreateDXGIFactory;
}

void* WrapCreateDXGIFactory1ForFrameSync(void* real) {
    if (!g_active || !real) return real;
    if (!g_origCreateDXGIFactory1 && real != (void*)MyCreateDXGIFactory1)
        g_origCreateDXGIFactory1 = (CreateDXGIFactory_t)real;
    return (void*)MyCreateDXGIFactory1;
}

void* WrapCreateDXGIFactory2ForFrameSync(void* real) {
    if (!g_active || !real) return real;
    if (!g_origCreateDXGIFactory2 && real != (void*)MyCreateDXGIFactory2)
        g_origCreateDXGIFactory2 = (CreateDXGIFactory2_t)real;
    return (void*)MyCreateDXGIFactory2;
}

}  // namespace autoplay

#endif  // _WIN64
