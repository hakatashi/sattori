// フレーム同期キャプチャ(reports/104・105)。説明はframe_sync_hook.hを参照。
#include "frame_sync_hook.h"
#include "frame_sync_audio.h"
#include "logging.h"
#include <stdlib.h>
#include <string.h>

namespace autoplay {

namespace {

// ---- 素の型(DirectX SDKヘッダを使わない方針、fps_limiter_hook.cppと同じ) ----
struct SurfDesc {  // D3DSURFACE_DESC (D3D9)
    DWORD Format, Type, Usage, Pool, MultiSampleType, MultiSampleQuality, Width, Height;
};
struct SurfDesc8 {  // D3DSURFACE_DESC (D3D8: Sizeあり、MultiSampleQualityなし)
    DWORD Format, Type, Usage, Pool;
    UINT Size;
    DWORD MultiSampleType;
    UINT Width, Height;
};
struct LockedRect {  // D3DLOCKED_RECT
    INT Pitch;
    void* pBits;
};
typedef ULONG(WINAPI* Release_t)(void*);
typedef HRESULT(WINAPI* GetBackBuffer_t)(void* dev, UINT swapChain, UINT backBuffer, DWORD type,
                                          void** surf);                       // device[18]
typedef HRESULT(WINAPI* GetRenderTargetData_t)(void* dev, void* rt, void* dst);  // device[32]
typedef HRESULT(WINAPI* CreateOffscreenPlainSurface_t)(void* dev, UINT w, UINT h, DWORD format,
                                                        DWORD pool, void** surf,
                                                        HANDLE* shared);      // device[36]
typedef HRESULT(WINAPI* GetDesc_t)(void* surf, SurfDesc* d);                  // surface[12]
typedef HRESULT(WINAPI* LockRect_t)(void* surf, LockedRect* lr, const RECT* rect,
                                     DWORD flags);                            // surface[13]/D3D8[9]
typedef HRESULT(WINAPI* UnlockRect_t)(void* surf);                            // surface[14]/D3D8[10]

typedef HRESULT(WINAPI* GetBackBuffer8_t)(void* dev, UINT backBuffer, DWORD type,
                                           void** surf);                      // D3D8 device[16]
typedef HRESULT(WINAPI* GetRasterStatus8_t)(void* dev, void* status);         // D3D8 device[17]
typedef HRESULT(WINAPI* CreateImageSurface8_t)(void* dev, UINT w, UINT h, DWORD format,
                                                void** surf);                 // D3D8 device[27]
typedef HRESULT(WINAPI* CopyRects8_t)(void* dev, void* src, const RECT* rects, UINT cRects,
                                       void* dst, const POINT* pts);          // D3D8 device[28]
typedef HRESULT(WINAPI* GetDesc8_t)(void* surf, SurfDesc8* d);                // D3D8 surface[8]

const DWORD kD3DFMT_R8G8B8 = 20, kD3DFMT_A8R8G8B8 = 21, kD3DFMT_X8R8G8B8 = 22,
            kD3DFMT_R5G6B5 = 23, kD3DFMT_X1R5G5B5 = 24;
const DWORD kD3DPOOL_SYSTEMMEM = 2;
const DWORD kD3DLOCK_READONLY = 0x10;

inline void** VT(void* obj) { return *(void***)obj; }

struct RasterStatus {  // D3DRASTER_STATUS
    BOOL InVBlank;
    UINT ScanLine;
};
typedef HRESULT(WINAPI* GetRasterStatus_t)(void* dev, UINT swapChain, RasterStatus* status);  // device[19]
GetRasterStatus_t g_origGetRasterStatus = nullptr;
GetRasterStatus8_t g_origGetRasterStatus8 = nullptr;

// ---- 仮想時計 ----
typedef BOOL(WINAPI* QueryPerformanceCounter_t)(LARGE_INTEGER*);
typedef DWORD(WINAPI* timeGetTime_t)();
typedef DWORD(WINAPI* GetTickCount_t)();
typedef void(WINAPI* Sleep_t)(DWORD);

QueryPerformanceCounter_t g_origQPC = nullptr;
timeGetTime_t g_origTimeGetTime = nullptr;
GetTickCount_t g_origGetTickCount = nullptr;
Sleep_t g_origSleep = nullptr;

bool g_active = false;
volatile LONG g_virtualMode = 0;  // 0: 実時間のまま素通し、1: 仮想時計(最初のPresent以降)
DWORD g_mainThreadId = 0;
CRITICAL_SECTION g_clockCs;
LONGLONG g_freq = 0;       // QPCの周波数(本物)
LONGLONG g_vt = 0;         // 仮想時刻(QPCのティック)
LONGLONG g_vtBase = 0;     // 仮想時計へ切り替えた瞬間の時刻
DWORD g_tgtBase = 0, g_tickBase = 0;
// メインスレッドがタイマーを1回読むたびに進める量。1/60秒の1/1024(約16マイクロ秒)。
// ゲームのウェイトがタイマーのポーリングだけで出来ていても1024回以内で抜ける。
// 大きくすると、1フレームに何度もタイマーを読むタイトルで1フレームが1/60秒より長く見え、
// 画面上のfps表示が60を下回る(1/256ではth12が58〜60と表示された)。
LONGLONG g_stepTicks = 0;

bool g_diag = false;
volatile LONG g_diagQpcMain = 0, g_diagQpcOther = 0;
volatile LONG g_diagTgtMain = 0, g_diagTgtOther = 0;
volatile LONG g_diagGtcMain = 0, g_diagGtcOther = 0;
volatile LONG g_diagSlpMain = 0, g_diagSlpOther = 0;

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

inline bool OnMainThread() { return GetCurrentThreadId() == g_mainThreadId; }

BOOL WINAPI MyQueryPerformanceCounter(LARGE_INTEGER* out) {
    if (!g_virtualMode) return g_origQPC(out);
    bool main = OnMainThread();
    if (g_diag) InterlockedIncrement(main ? &g_diagQpcMain : &g_diagQpcOther);
    out->QuadPart = ReadVirtual(main ? g_stepTicks : 0);
    return TRUE;
}

DWORD WINAPI MyTimeGetTime() {
    if (!g_virtualMode) return g_origTimeGetTime();
    bool main = OnMainThread();
    if (g_diag) InterlockedIncrement(main ? &g_diagTgtMain : &g_diagTgtOther);
    LONGLONG v = ReadVirtual(main ? g_stepTicks : 0);
    return g_tgtBase + (DWORD)((v - g_vtBase) * 1000 / g_freq);
}

DWORD WINAPI MyGetTickCount() {
    if (!g_virtualMode) return g_origGetTickCount();
    bool main = OnMainThread();
    if (g_diag) InterlockedIncrement(main ? &g_diagGtcMain : &g_diagGtcOther);
    LONGLONG v = ReadVirtual(main ? g_stepTicks : 0);
    return g_tickBase + (DWORD)((v - g_vtBase) * 1000 / g_freq);
}

void WINAPI MySleep(DWORD ms) {
    if (g_diag && g_virtualMode) InterlockedIncrement(OnMainThread() ? &g_diagSlpMain : &g_diagSlpOther);
    if (!g_virtualMode || !OnMainThread()) {
        if (g_origSleep) g_origSleep(ms); else Sleep(ms);
        return;
    }
    if (ms > 0 && ms != INFINITE) ReadVirtual((LONGLONG)ms * g_freq / 1000);
    if (g_origSleep) g_origSleep(0); else Sleep(0);  // 他スレッドへ実行を譲るだけで、実時間は待たない
}

// vpatch (vpatch_th06.dll / vpatch_th10.dll) が SleepType=1 で使う waitable timer の仮想化。
typedef HANDLE(WINAPI* CreateWaitableTimerA_t)(LPSECURITY_ATTRIBUTES, BOOL, LPCSTR);
typedef BOOL(WINAPI* SetWaitableTimer_t)(HANDLE, const LARGE_INTEGER*, LONG, PTIMERAPCROUTINE,
                                         LPVOID, BOOL);
typedef DWORD(WINAPI* WaitForSingleObject_t)(HANDLE, DWORD);

CreateWaitableTimerA_t g_origCreateWaitableTimerA = nullptr;
SetWaitableTimer_t g_origSetWaitableTimer = nullptr;
WaitForSingleObject_t g_origWaitForSingleObject = nullptr;

const int kMaxVpatchTimers = 16;
HANDLE g_vpatchTimers[kMaxVpatchTimers];
int g_nVpatchTimers = 0;

void TrackVpatchTimer(HANDLE h) {
    if (!h) return;
    EnterCriticalSection(&g_clockCs);
    bool found = false;
    for (int i = 0; i < g_nVpatchTimers; i++) {
        if (g_vpatchTimers[i] == h) { found = true; break; }
    }
    if (!found && g_nVpatchTimers < kMaxVpatchTimers) g_vpatchTimers[g_nVpatchTimers++] = h;
    LeaveCriticalSection(&g_clockCs);
}

bool IsTrackedVpatchTimer(HANDLE h) {
    if (!h) return false;
    EnterCriticalSection(&g_clockCs);
    bool found = false;
    for (int i = 0; i < g_nVpatchTimers; i++) {
        if (g_vpatchTimers[i] == h) { found = true; break; }
    }
    LeaveCriticalSection(&g_clockCs);
    return found;
}

HANDLE WINAPI MyCreateWaitableTimerA(LPSECURITY_ATTRIBUTES sa, BOOL manualReset, LPCSTR name) {
    HANDLE h = g_origCreateWaitableTimerA(sa, manualReset, name);
    TrackVpatchTimer(h);
    return h;
}

BOOL WINAPI MySetWaitableTimer(HANDLE h, const LARGE_INTEGER* pDue, LONG period,
                               PTIMERAPCROUTINE comp, LPVOID arg, BOOL resume) {
    TrackVpatchTimer(h);
    if (g_virtualMode && OnMainThread()) {
        if (pDue && pDue->QuadPart < 0) {
            LONGLONG ticks = (-pDue->QuadPart) * g_freq / 10000000LL;
            if (ticks > 0) ReadVirtual(ticks);
        }
        return TRUE;
    }
    return g_origSetWaitableTimer(h, pDue, period, comp, arg, resume);
}

DWORD WINAPI MyWaitForSingleObject(HANDLE h, DWORD ms) {
    if (g_virtualMode && OnMainThread() && IsTrackedVpatchTimer(h)) {
        if (g_origSleep) g_origSleep(0); else Sleep(0);
        return WAIT_OBJECT_0;
    }
    return g_origWaitForSingleObject(h, ms);
}

bool HookModuleIATEntry(HMODULE hMod, const char* dllName, const char* funcName, void* newFunc,
                        void** outOld) {
    if (!hMod) return false;
    BYTE* base = (BYTE*)hMod;
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
            VirtualProtect(&thunk->u1.Function, sizeof(void*), PAGE_EXECUTE_READWRITE,
                            &oldProt);
            if (outOld) *outOld = (void*)thunk->u1.Function;
            thunk->u1.Function = (ULONG_PTR)newFunc;
            VirtualProtect(&thunk->u1.Function, sizeof(void*), oldProt, &oldProt);
            return true;
        }
    }
    return false;
}

bool HookIATEntry(const char* dllName, const char* funcName, void* newFunc, void** outOld) {
    return HookModuleIATEntry(GetModuleHandle(NULL), dllName, funcName, newFunc, outOld);
}

void HookVpatchModule(const char* modName) {
    HMODULE hMod = GetModuleHandleA(modName);
    if (!hMod) return;
    void* tmpQpc = nullptr;
    void* tmpSleep = nullptr;
    void* tmpCwt = nullptr;
    void* tmpSwt = nullptr;
    void* tmpWfso = nullptr;
    bool q = HookModuleIATEntry(hMod, "KERNEL32.dll", "QueryPerformanceCounter",
                                (void*)MyQueryPerformanceCounter,
                                g_origQPC ? &tmpQpc : (void**)&g_origQPC);
    bool s = HookModuleIATEntry(hMod, "KERNEL32.dll", "Sleep",
                                (void*)MySleep,
                                g_origSleep ? &tmpSleep : (void**)&g_origSleep);
    bool c = HookModuleIATEntry(hMod, "KERNEL32.dll", "CreateWaitableTimerA",
                                (void*)MyCreateWaitableTimerA,
                                g_origCreateWaitableTimerA ? &tmpCwt : (void**)&g_origCreateWaitableTimerA);
    bool w = HookModuleIATEntry(hMod, "KERNEL32.dll", "SetWaitableTimer",
                                (void*)MySetWaitableTimer,
                                g_origSetWaitableTimer ? &tmpSwt : (void**)&g_origSetWaitableTimer);
    bool f = HookModuleIATEntry(hMod, "KERNEL32.dll", "WaitForSingleObject",
                                (void*)MyWaitForSingleObject,
                                g_origWaitForSingleObject ? &tmpWfso : (void**)&g_origWaitForSingleObject);
    Log("FrameSync: hooked vpatch IAT (%s) QPC=%d Sleep=%d CreateWT=%d SetWT=%d WFSO=%d",
        modName, q ? 1 : 0, s ? 1 : 0, c ? 1 : 0, w ? 1 : 0, f ? 1 : 0);
}

LONGLONG RealNow() {
    // このDLL自身のインポートなのでフックの影響を受けない(本物の時刻)。
    LARGE_INTEGER t;
    QueryPerformanceCounter(&t);
    return t.QuadPart;
}

void EnterVirtualMode() {
    g_mainThreadId = GetCurrentThreadId();
    g_vt = g_vtBase = RealNow();
    g_tgtBase = g_origTimeGetTime ? g_origTimeGetTime() : 0;
    g_tickBase = g_origGetTickCount ? g_origGetTickCount() : GetTickCount();
    InterlockedExchange(&g_virtualMode, 1);
    Log("FrameSync: virtual clock on (main thread id=%lu, step=%lld ticks, freq=%lld)",
        (unsigned long)g_mainThreadId, g_stepTicks, g_freq);
}

// ---- 実時間で動くスレッドの追跡(reports/107) ----
// ゲームは読み込み等を別スレッドに任せ、メインスレッドは完了をフレームごとに確かめる。
// 上限を外していると、その間もメインスレッドが実時間の数倍の速さでフレームを進めるので、
// 読み込み待ち(BGMの開始待ち、ロード画面)が動画上で伸びる。仮想時計が動き出した後に
// 作られたスレッドを追跡し、FRAME_SYNC_THROTTLE_WHILE_THREADS=1 のときは、それが生きて
// いる間だけ実時間60Hzの上限を戻す(実機と同じ比率で読み込みが進む)。
typedef HANDLE(WINAPI* CreateThread_t)(LPSECURITY_ATTRIBUTES, SIZE_T, LPTHREAD_START_ROUTINE,
                                       LPVOID, DWORD, LPDWORD);
CreateThread_t g_origCreateThread = nullptr;
const int kMaxTracked = 64;
struct Tracked {
    HANDLE h;
    DWORD tid;
    DWORD startRva;
    LONGLONG createdFrame;
    LONGLONG createdReal;
};
Tracked g_tracked[kMaxTracked];
int g_ntracked = 0;
CRITICAL_SECTION g_threadCs;
bool g_throttleWhileThreads = false;
DWORD g_trackMaxMs = 10000;  // これより長く生きるスレッドは読み込みではないとみなして外す
LONGLONG g_presentCountForThreads = 0;
LONGLONG g_framesThrottledForThreads = 0;

HANDLE WINAPI MyCreateThread(LPSECURITY_ATTRIBUTES sa, SIZE_T stack, LPTHREAD_START_ROUTINE fn,
                             LPVOID param, DWORD flags, LPDWORD tidOut) {
    DWORD tid = 0;
    HANDLE h = g_origCreateThread(sa, stack, fn, param, flags, &tid);
    if (tidOut) *tidOut = tid;
    DWORD rva = (DWORD)((BYTE*)fn - (BYTE*)GetModuleHandle(NULL));
    if (h && g_virtualMode) {
        HANDLE dup = nullptr;
        DuplicateHandle(GetCurrentProcess(), h, GetCurrentProcess(), &dup, SYNCHRONIZE, FALSE, 0);
        EnterCriticalSection(&g_threadCs);
        if (dup && g_ntracked < kMaxTracked) {
            LARGE_INTEGER t;
            QueryPerformanceCounter(&t);
            g_tracked[g_ntracked++] = {dup, tid, rva, g_presentCountForThreads, t.QuadPart};
        } else if (dup) {
            CloseHandle(dup);
        }
        LeaveCriticalSection(&g_threadCs);
    }
    Log("FrameSync: CreateThread tid=%lu start=0x%lX frame=%lld virtual=%d", (unsigned long)tid,
        (unsigned long)rva, g_presentCountForThreads, (int)g_virtualMode);
    return h;
}

// 追跡中のスレッドのうち生きているものの数(終わったものはログを出して外す)。
int CountLiveTracked(LONGLONG now) {
    int live = 0;
    EnterCriticalSection(&g_threadCs);
    for (int i = 0; i < g_ntracked;) {
        Tracked& t = g_tracked[i];
        double ms = (double)(now - t.createdReal) * 1000.0 / (double)g_freq;
        bool done = WaitForSingleObject(t.h, 0) == WAIT_OBJECT_0;
        if (done || ms > g_trackMaxMs) {
            Log("FrameSync: thread tid=%lu start=0x%lX %s frames=%lld(%lld..%lld) real_ms=%.0f",
                (unsigned long)t.tid, (unsigned long)t.startRva, done ? "exited" : "untracked(long-lived)",
                g_presentCountForThreads - t.createdFrame, t.createdFrame,
                g_presentCountForThreads, ms);
            CloseHandle(t.h);
            g_tracked[i] = g_tracked[--g_ntracked];
            continue;
        }
        live++;
        i++;
    }
    LeaveCriticalSection(&g_threadCs);
    return live;
}

// ---- 取り込み ----
char g_pipePath[MAX_PATH] = {0};
char g_stopPath[MAX_PATH] = {0};
HANDLE g_pipe = INVALID_HANDLE_VALUE;
bool g_captureDone = false;   // 停止済み、または失敗して諦めた
volatile LONG g_unthrottled = 0;
void* g_sysSurf = nullptr;
UINT g_capW = 0, g_capH = 0;
DWORD g_capFmt = 0;
UINT g_bytesPerPixel = 4;
LONGLONG g_presentCount = 0;
volatile LONG g_presentCount32 = 0;
LONGLONG g_framesWritten = 0;

// 統計(600フレームごとにログへ出して消す)。単位はQPCのティック(本物)。
const int kStatsEvery = 600;
LONGLONG g_statReadback = 0, g_statWrite = 0, g_statPresent = 0, g_statGame = 0;
LONGLONG g_statReadback2 = 0;
LONGLONG g_statAudio = 0;
bool g_skipPresent = false;
bool g_probeReadback2 = false;
bool g_probeNoReadback = false;
// 読み出しの1フレーム遅延(パイプライン化)。GetRenderTargetDataは描画コマンドの列に積まれる
// だけなので、積んだ直後にLockRectで待つと、ゲーム本体が描画の完了まで止まる。サーフェスを
// 2枚持ち、今のフレームの読み出しを積んでから「1つ前のフレーム」をロックして書き出すと、
// 描画スレッドが今のフレームを描いている間に、ゲーム本体は次のフレームの処理へ進める。
bool g_pipeline = true;
void* g_surfs[2] = {nullptr, nullptr};
int g_pendingSurf = -1;  // 読み出しを積んだまま、まだ書き出していないサーフェス
void* g_sysSurf2 = nullptr;
LONGLONG g_statWindowStart = 0, g_statWindowStartFrame = 0;
LONGLONG g_prePresentEnd = 0, g_postPresentEnd = 0;

bool g_isD3D8 = false;
void* g_capDev = nullptr;
bool g_loggedCaptureStart = false;

const char* PixFmtName(DWORD fmt) {
    switch (fmt) {
        case kD3DFMT_R8G8B8: return "bgr24";
        case kD3DFMT_A8R8G8B8:
        case kD3DFMT_X8R8G8B8: return "bgr0";
        case kD3DFMT_R5G6B5: return "rgb565le";
        case kD3DFMT_X1R5G5B5: return "rgb555le";
        default: return nullptr;
    }
}

UINT BytesPerPixel(DWORD fmt) {
    switch (fmt) {
        case kD3DFMT_R8G8B8: return 3;
        case kD3DFMT_R5G6B5:
        case kD3DFMT_X1R5G5B5: return 2;
        default: return 4;
    }
}

void GiveUpCapture(const char* why, HRESULT hr) {
    Log("FrameSync: ERROR %s (hr=0x%08lX)。取り込みを中止します", why, (unsigned long)hr);
    if (g_pipe != INVALID_HANDLE_VALUE) CloseHandle(g_pipe);
    g_pipe = INVALID_HANDLE_VALUE;
    g_captureDone = true;
    InterlockedExchange(&g_unthrottled, 0);
    FrameSyncAudioClose();
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

void FlushPending();

void StopCapture() {
    FlushPending();
    if (g_pipe != INVALID_HANDLE_VALUE) CloseHandle(g_pipe);
    g_pipe = INVALID_HANDLE_VALUE;
    g_captureDone = true;
    // 以後は実時間60Hzへ戻す(取り込み無しで全速のまま回し続ける意味が無い)。
    InterlockedExchange(&g_unthrottled, 0);
    Log("FrameSync: capture stopped frames_written=%lld present_count=%lld "
        "frames_with_live_threads=%lld throttle_while_threads=%d", g_framesWritten,
        g_presentCount, g_framesThrottledForThreads, g_throttleWhileThreads ? 1 : 0);
    FrameSyncAudioClose();
}

// ロック済みでないサーフェスをロックし、中身をパイプへ書く。ロックは、そのサーフェスへの
// 読み出し(と、それより前に発行した描画)が終わるまで待つ。
bool WriteSurface(void* surf, LONGLONG* lockTicks, LONGLONG* writeTicks) {
    LONGLONG t0 = RealNow();
    LockedRect lr = {};
    int lockIdx = g_isD3D8 ? 9 : 13;
    int unlockIdx = g_isD3D8 ? 10 : 14;
    HRESULT hr = ((LockRect_t)VT(surf)[lockIdx])(surf, &lr, NULL, kD3DLOCK_READONLY);
    if (FAILED(hr) || !lr.pBits) {
        GiveUpCapture("LockRect failed", hr);
        return false;
    }
    LONGLONG t1 = RealNow();
    const BYTE* bits = (const BYTE*)lr.pBits;
    UINT rowBytes = g_capW * g_bytesPerPixel;
    bool ok = true;
    if ((UINT)lr.Pitch == rowBytes) {
        ok = WriteAll(bits, rowBytes * g_capH);
    } else {
        for (UINT y = 0; y < g_capH && ok; y++) ok = WriteAll(bits + (size_t)y * lr.Pitch, rowBytes);
    }
    DWORD err = ok ? 0 : GetLastError();
    ((UnlockRect_t)VT(surf)[unlockIdx])(surf);
    if (!ok) {
        GiveUpCapture("WriteFile to pipe failed", (HRESULT)err);
        return false;
    }
    *lockTicks += t1 - t0;
    *writeTicks += RealNow() - t1;
    g_framesWritten++;
    return true;
}

// パイプライン化で1フレームぶん手元に残っている読み出しを書き出す(停止時)。
void FlushPending() {
    if (g_pendingSurf < 0) return;
    int idx = g_pendingSurf;
    g_pendingSurf = -1;
    WriteSurface(g_surfs[idx], &g_statReadback, &g_statWrite);
}

void ResetCaptureDevice(void* newDev) {
    if (g_capDev == newDev) return;
    if (g_capDev != nullptr) {
        Log("FrameSync: device changed (%p -> %p), recreating surfaces", g_capDev, newDev);
        if (g_pendingSurf >= 0) {
            int idx = g_pendingSurf;
            g_pendingSurf = -1;
            WriteSurface(g_surfs[idx], &g_statReadback, &g_statWrite);
        }
        if (g_surfs[0] && g_surfs[0] != g_sysSurf) ((Release_t)VT(g_surfs[0])[2])(g_surfs[0]);
        if (g_surfs[1] && g_surfs[1] != g_sysSurf) ((Release_t)VT(g_surfs[1])[2])(g_surfs[1]);
        if (g_sysSurf) ((Release_t)VT(g_sysSurf)[2])(g_sysSurf);
        if (g_sysSurf2) ((Release_t)VT(g_sysSurf2)[2])(g_sysSurf2);
        g_surfs[0] = g_surfs[1] = g_sysSurf = g_sysSurf2 = nullptr;
    }
    g_capDev = newDev;
}

void CaptureFrame(void* dev) {
    ResetCaptureDevice(dev);
    LONGLONG t0 = RealNow();
    void* bb = nullptr;
    HRESULT hr = ((GetBackBuffer_t)VT(dev)[18])(dev, 0, 0, 0 /*MONO*/, &bb);
    if (FAILED(hr) || !bb) return GiveUpCapture("GetBackBuffer failed", hr);

    SurfDesc d = {};
    ((GetDesc_t)VT(bb)[12])(bb, &d);
    if (!g_sysSurf) {
        const char* pix = PixFmtName(d.Format);
        if (!pix) {
            ((Release_t)VT(bb)[2])(bb);
            return GiveUpCapture("unsupported backbuffer format", (HRESULT)d.Format);
        }
        hr = ((CreateOffscreenPlainSurface_t)VT(dev)[36])(dev, d.Width, d.Height, d.Format,
                                                          kD3DPOOL_SYSTEMMEM, &g_sysSurf, NULL);
        if (FAILED(hr) || !g_sysSurf) {
            ((Release_t)VT(bb)[2])(bb);
            return GiveUpCapture("CreateOffscreenPlainSurface failed", hr);
        }
        g_capW = d.Width;
        g_capH = d.Height;
        g_capFmt = d.Format;
        g_bytesPerPixel = BytesPerPixel(d.Format);
        if (!g_loggedCaptureStart) {
            g_loggedCaptureStart = true;
            // 録画側はこの行を見てffmpegのrawvideo入力の大きさ・画素形式を決める。
            // 最初のフレームを書く前に出すこと(録画側がffmpegを起動するまで書き込みは詰まる)。
            Log("FrameSync: capture start width=%u height=%u d3dfmt=%lu pix_fmt=%s multisample=%lu",
                g_capW, g_capH, (unsigned long)d.Format, pix, (unsigned long)d.MultiSampleType);
        } else {
            Log("FrameSync: recreated surfaces width=%u height=%u d3dfmt=%lu pix_fmt=%s",
                g_capW, g_capH, (unsigned long)d.Format, pix);
        }
    } else if (d.Width != g_capW || d.Height != g_capH || d.Format != g_capFmt) {
        ((Release_t)VT(bb)[2])(bb);
        return GiveUpCapture("backbuffer size/format changed", (HRESULT)d.Format);
    }

    if (g_probeNoReadback) {
        // 診断: 読み出しをせず、黒いフレームだけを書く(描画だけの速度の上限を測る)。
        ((Release_t)VT(bb)[2])(bb);
        static BYTE* black = nullptr;
        DWORD size = g_capW * g_capH * g_bytesPerPixel;
        if (!black) black = (BYTE*)calloc(size, 1);
        LONGLONG w0 = RealNow();
        if (!WriteAll(black, size))
            return GiveUpCapture("WriteFile to pipe failed", (HRESULT)GetLastError());
        g_framesWritten++;
        g_statWrite += RealNow() - w0;
        return;
    }

    if (g_pipeline) {
        int cur = (int)(g_presentCount & 1);
        if (!g_surfs[cur]) {
            if (cur == 0) {
                g_surfs[0] = g_sysSurf;
            } else {
                hr = ((CreateOffscreenPlainSurface_t)VT(dev)[36])(
                    dev, d.Width, d.Height, d.Format, kD3DPOOL_SYSTEMMEM, &g_surfs[1], NULL);
                if (FAILED(hr) || !g_surfs[1]) {
                    ((Release_t)VT(bb)[2])(bb);
                    return GiveUpCapture("CreateOffscreenPlainSurface(2) failed", hr);
                }
            }
        }
        // 今のフレームの読み出しを積む(待たない)。
        hr = ((GetRenderTargetData_t)VT(dev)[32])(dev, bb, g_surfs[cur]);
        ((Release_t)VT(bb)[2])(bb);
        if (FAILED(hr)) return GiveUpCapture("GetRenderTargetData failed", hr);
        int prev = g_pendingSurf;
        g_pendingSurf = cur;
        g_statReadback += RealNow() - t0;
        // 1つ前のフレームを書き出す(その読み出しが終わるまでここで待つ)。
        if (prev >= 0) WriteSurface(g_surfs[prev], &g_statReadback, &g_statWrite);
        return;
    }

    hr = ((GetRenderTargetData_t)VT(dev)[32])(dev, bb, g_sysSurf);
    if (FAILED(hr)) {
        ((Release_t)VT(bb)[2])(bb);
        return GiveUpCapture("GetRenderTargetData failed", hr);
    }

    // GetRenderTargetDataは描画コマンドの列に積まれるだけで、すぐ戻る。実際に待つのは
    // LockRect(ここまでに発行した描画と読み出しがすべて終わるまで)。
    LockedRect lr = {};
    hr = ((LockRect_t)VT(g_sysSurf)[13])(g_sysSurf, &lr, NULL, kD3DLOCK_READONLY);
    if (FAILED(hr) || !lr.pBits) {
        ((Release_t)VT(bb)[2])(bb);
        return GiveUpCapture("LockRect failed", hr);
    }
    LONGLONG t1 = RealNow();

    LONGLONG probeTicks = 0;
    if (g_probeReadback2) {
        // 診断: 描画が終わった状態でもう一度読み、読み出しそのものの時間を測る。
        if (!g_sysSurf2)
            ((CreateOffscreenPlainSurface_t)VT(dev)[36])(dev, d.Width, d.Height, d.Format,
                                                         kD3DPOOL_SYSTEMMEM, &g_sysSurf2, NULL);
        if (g_sysSurf2) {
            LockedRect lr2 = {};
            ((GetRenderTargetData_t)VT(dev)[32])(dev, bb, g_sysSurf2);
            if (SUCCEEDED(((LockRect_t)VT(g_sysSurf2)[13])(g_sysSurf2, &lr2, NULL,
                                                           kD3DLOCK_READONLY)))
                ((UnlockRect_t)VT(g_sysSurf2)[14])(g_sysSurf2);
            probeTicks = RealNow() - t1;
            g_statReadback2 += probeTicks;
        }
    }
    ((Release_t)VT(bb)[2])(bb);

    const BYTE* bits = (const BYTE*)lr.pBits;
    UINT rowBytes = g_capW * g_bytesPerPixel;
    bool ok = true;
    if ((UINT)lr.Pitch == rowBytes) {
        ok = WriteAll(bits, rowBytes * g_capH);
    } else {
        for (UINT y = 0; y < g_capH && ok; y++) ok = WriteAll(bits + (size_t)y * lr.Pitch, rowBytes);
    }
    DWORD err = ok ? 0 : GetLastError();
    ((UnlockRect_t)VT(g_sysSurf)[14])(g_sysSurf);
    if (!ok) return GiveUpCapture("WriteFile to pipe failed", (HRESULT)err);
    LONGLONG t2 = RealNow();

    g_framesWritten++;
    g_statReadback += t1 - t0;
    g_statWrite += t2 - t1 - probeTicks;
}

void CaptureFrameD3D8(void* dev) {
    ResetCaptureDevice(dev);
    LONGLONG t0 = RealNow();
    void* bb = nullptr;
    HRESULT hr = ((GetBackBuffer8_t)VT(dev)[16])(dev, 0, 0 /*MONO*/, &bb);
    if (FAILED(hr) || !bb) return GiveUpCapture("GetBackBuffer8 failed", hr);

    SurfDesc8 d = {};
    ((GetDesc8_t)VT(bb)[8])(bb, &d);
    if (!g_sysSurf) {
        const char* pix = PixFmtName(d.Format);
        if (!pix) {
            ((Release_t)VT(bb)[2])(bb);
            return GiveUpCapture("unsupported backbuffer format", (HRESULT)d.Format);
        }
        hr = ((CreateImageSurface8_t)VT(dev)[27])(dev, d.Width, d.Height, d.Format, &g_sysSurf);
        if (FAILED(hr) || !g_sysSurf) {
            ((Release_t)VT(bb)[2])(bb);
            return GiveUpCapture("CreateImageSurface failed", hr);
        }
        g_capW = d.Width;
        g_capH = d.Height;
        g_capFmt = d.Format;
        g_bytesPerPixel = BytesPerPixel(d.Format);
        if (!g_loggedCaptureStart) {
            g_loggedCaptureStart = true;
            Log("FrameSync: capture start width=%u height=%u d3dfmt=%lu pix_fmt=%s multisample=%lu",
                g_capW, g_capH, (unsigned long)d.Format, pix, (unsigned long)d.MultiSampleType);
        } else {
            Log("FrameSync: recreated surfaces width=%u height=%u d3dfmt=%lu pix_fmt=%s",
                g_capW, g_capH, (unsigned long)d.Format, pix);
        }
    } else if (d.Width != g_capW || d.Height != g_capH || d.Format != g_capFmt) {
        ((Release_t)VT(bb)[2])(bb);
        return GiveUpCapture("backbuffer size/format changed", (HRESULT)d.Format);
    }

    if (g_probeNoReadback) {
        ((Release_t)VT(bb)[2])(bb);
        static BYTE* black = nullptr;
        DWORD size = g_capW * g_capH * g_bytesPerPixel;
        if (!black) black = (BYTE*)calloc(size, 1);
        LONGLONG w0 = RealNow();
        if (!WriteAll(black, size))
            return GiveUpCapture("WriteFile to pipe failed", (HRESULT)GetLastError());
        g_framesWritten++;
        g_statWrite += RealNow() - w0;
        return;
    }

    if (g_pipeline) {
        int cur = (int)(g_presentCount & 1);
        if (!g_surfs[cur]) {
            if (cur == 0) {
                g_surfs[0] = g_sysSurf;
            } else {
                hr = ((CreateImageSurface8_t)VT(dev)[27])(
                    dev, d.Width, d.Height, d.Format, &g_surfs[1]);
                if (FAILED(hr) || !g_surfs[1]) {
                    ((Release_t)VT(bb)[2])(bb);
                    return GiveUpCapture("CreateImageSurface(2) failed", hr);
                }
            }
        }
        hr = ((CopyRects8_t)VT(dev)[28])(dev, bb, NULL, 0, g_surfs[cur], NULL);
        ((Release_t)VT(bb)[2])(bb);
        if (FAILED(hr)) return GiveUpCapture("CopyRects failed", hr);
        int prev = g_pendingSurf;
        g_pendingSurf = cur;
        g_statReadback += RealNow() - t0;
        if (prev >= 0) WriteSurface(g_surfs[prev], &g_statReadback, &g_statWrite);
        return;
    }

    hr = ((CopyRects8_t)VT(dev)[28])(dev, bb, NULL, 0, g_sysSurf, NULL);
    ((Release_t)VT(bb)[2])(bb);
    if (FAILED(hr)) return GiveUpCapture("CopyRects failed", hr);
    g_statReadback += RealNow() - t0;
    WriteSurface(g_sysSurf, &g_statReadback, &g_statWrite);
}

HRESULT WINAPI MyGetRasterStatus(void* dev, UINT swapChain, RasterStatus* status) {
    if (!g_virtualMode) {
        return g_origGetRasterStatus ? g_origGetRasterStatus(dev, swapChain, status) : 0;
    }
    if (status) {
        status->InVBlank = TRUE;
        status->ScanLine = 0;
    }
    return 0;
}

HRESULT WINAPI MyGetRasterStatus8(void* dev, RasterStatus* status) {
    if (!g_virtualMode) {
        return g_origGetRasterStatus8 ? g_origGetRasterStatus8(dev, status) : 0;
    }
    if (status) {
        status->InVBlank = TRUE;
        status->ScanLine = 0;
    }
    return 0;
}

int OnPrePresentCommon(void* dev, bool isD3D8) {
    g_isD3D8 = isD3D8;
    void** vtable = VT(dev);
    if (isD3D8) {
        if (vtable && vtable[17] != (void*)MyGetRasterStatus8) {
            DWORD oldProt;
            if (VirtualProtect(&vtable[17], sizeof(void*), PAGE_EXECUTE_READWRITE, &oldProt)) {
                g_origGetRasterStatus8 = (GetRasterStatus8_t)vtable[17];
                vtable[17] = (void*)MyGetRasterStatus8;
                VirtualProtect(&vtable[17], sizeof(void*), oldProt, &oldProt);
                Log("FrameSync: hooked GetRasterStatus8 (vtable[17])");
            }
        }
    } else if (vtable && vtable[19] != (void*)MyGetRasterStatus) {
        DWORD oldProt;
        if (VirtualProtect(&vtable[19], sizeof(void*), PAGE_EXECUTE_READWRITE, &oldProt)) {
            g_origGetRasterStatus = (GetRasterStatus_t)vtable[19];
            vtable[19] = (void*)MyGetRasterStatus;
            VirtualProtect(&vtable[19], sizeof(void*), oldProt, &oldProt);
            Log("FrameSync: hooked GetRasterStatus (vtable[19])");
        }
    }
    LONGLONG entry = RealNow();
    if (!g_virtualMode) {
        EnterVirtualMode();
        g_statWindowStart = entry;
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
            // 停止要求の確認は8フレームに1回(ファイルの有無を見るだけ)。
            if (g_stopPath[0] && (g_presentCount & 7) == 0 &&
                GetFileAttributesA(g_stopPath) != INVALID_FILE_ATTRIBUTES) {
                StopCapture();
            } else {
                if (isD3D8) CaptureFrameD3D8(dev);
                else CaptureFrame(dev);
                captured = !g_captureDone;
            }
        }
    }

    // 仮想音声デバイス(frame_sync_audio、reports/107)。取り込んだフレームと同じ数だけ書く。
    if (FrameSyncAudioActive()) {
        LONGLONG a0 = RealNow();
        FrameSyncAudioMixFrame(captured);
        g_statAudio += RealNow() - a0;
    }

    if (g_presentCount - g_statWindowStartFrame >= kStatsEvery) {
        LONGLONG now = RealNow();
        double n = (double)(g_presentCount - g_statWindowStartFrame);
        double toMs = 1000.0 / (double)g_freq;
        double realMs = (double)(now - g_statWindowStart) * toMs;
        Log("FrameSync: stats frame=%lld written=%lld real_ms=%.0f fps=%.1f "
            "game_ms=%.3f readback_ms=%.3f write_ms=%.3f present_ms=%.3f unthrottled=%ld "
            "readback2_ms=%.3f audio_ms=%.3f",
            g_presentCount, g_framesWritten, realMs, n * 1000.0 / realMs,
            (double)g_statGame * toMs / n, (double)g_statReadback * toMs / n,
            (double)g_statWrite * toMs / n, (double)g_statPresent * toMs / n,
            (long)g_unthrottled, (double)g_statReadback2 * toMs / n,
            (double)g_statAudio * toMs / n);
        g_statGame = g_statReadback = g_statWrite = g_statPresent = g_statReadback2 = 0;
        g_statAudio = 0;
        g_statWindowStart = now;
        g_statWindowStartFrame = g_presentCount;
        if (g_diag) {
            Log("FrameSync: diag qpc=%ld/%ld tgt=%ld/%ld gtc=%ld/%ld slp=%ld/%ld vt_ms=%lld",
                InterlockedExchange(&g_diagQpcMain, 0), InterlockedExchange(&g_diagQpcOther, 0),
                InterlockedExchange(&g_diagTgtMain, 0), InterlockedExchange(&g_diagTgtOther, 0),
                InterlockedExchange(&g_diagGtcMain, 0), InterlockedExchange(&g_diagGtcOther, 0),
                InterlockedExchange(&g_diagSlpMain, 0), InterlockedExchange(&g_diagSlpOther, 0),
                g_freq ? (g_vt - g_vtBase) * 1000 / g_freq : 0LL);
        }
    }

    g_presentCountForThreads = g_presentCount;
    bool loading = CountLiveTracked(RealNow()) > 0;
    if (loading && g_unthrottled) g_framesThrottledForThreads++;

    g_prePresentEnd = RealNow();
    if (!g_unthrottled || (loading && g_throttleWhileThreads)) return kPresentThrottle;
    return g_skipPresent ? kPresentSkip : 0;
}

int OnPrePresent(void* dev) { return OnPrePresentCommon(dev, false); }
int OnPrePresentD3D8(void* dev) { return OnPrePresentCommon(dev, true); }

void OnPostPresent(void*) {
    if (g_virtualMode) AdvanceVirtualToFrame(g_presentCount);
    g_postPresentEnd = RealNow();
    // 上限の待ち(等速のとき)も含む。上限を外しているときは本来のPresentの所要時間。
    g_statPresent += g_postPresentEnd - g_prePresentEnd;
}

}  // namespace

bool FrameSyncActive() { return g_active; }

void FrameSyncSetUnthrottled(bool unthrottled) {
    if (!g_active) return;
    if (unthrottled && g_captureDone) return;
    InterlockedExchange(&g_unthrottled, unthrottled ? 1 : 0);
    Log("FrameSync: unthrottled=%d at frame=%lld", unthrottled ? 1 : 0, g_presentCount);
}

void FrameSyncSleepMs(DWORD ms) {
    if (!g_active) {
        Sleep(ms);
        return;
    }
    const DWORD kTimeoutMs = 300000;
    LONGLONG targetFrames = ((LONGLONG)ms * 60 + 999) / 1000;
    LONG startFrame = InterlockedCompareExchange(&g_presentCount32, 0, 0);
    DWORD realStart = GetTickCount();
    while ((LONGLONG)(InterlockedCompareExchange(&g_presentCount32, 0, 0) - startFrame) < targetFrames) {
        if (GetTickCount() - realStart >= kTimeoutMs) {
            Log("FrameSyncSleepMs: TIMEOUT waiting %lld frames (ms=%lu)",
                targetFrames, (unsigned long)ms);
            return;
        }
        Sleep(2);
    }
    while (CountLiveTracked(RealNow()) > 0) {
        if (GetTickCount() - realStart >= kTimeoutMs) {
            Log("FrameSyncSleepMs: TIMEOUT waiting live threads (ms=%lu)", (unsigned long)ms);
            return;
        }
        Sleep(10);
    }
}

bool InstallFrameSyncHook(int stepDiv) {
    const char* pipe = getenv("FRAME_SYNC_PIPE");
    if (!pipe || !pipe[0]) return false;
    strncpy(g_pipePath, pipe, MAX_PATH - 1);
    if (const char* stop = getenv("FRAME_SYNC_STOP")) strncpy(g_stopPath, stop, MAX_PATH - 1);

    if (const char* v = getenv("FRAME_SYNC_STEP_DIV")) {
        int d = atoi(v);
        if (d > 0) stepDiv = d;
    }
    if (stepDiv < 1) stepDiv = 1;

    if (const char* v = getenv("FRAME_SYNC_SKIP_PRESENT")) g_skipPresent = atoi(v) != 0;
    if (const char* v = getenv("FRAME_SYNC_PROBE_READBACK2")) g_probeReadback2 = atoi(v) != 0;
    if (const char* v = getenv("FRAME_SYNC_PROBE_NO_READBACK")) g_probeNoReadback = atoi(v) != 0;
    if (const char* v = getenv("FRAME_SYNC_PIPELINE")) g_pipeline = atoi(v) != 0;
    if (const char* v = getenv("FRAME_SYNC_THROTTLE_WHILE_THREADS"))
        g_throttleWhileThreads = atoi(v) != 0;
    if (const char* v = getenv("FRAME_SYNC_THREAD_MAX_MS")) g_trackMaxMs = atoi(v);
    if (const char* v = getenv("FRAME_SYNC_DIAG")) g_diag = atoi(v) != 0;
    if (g_probeReadback2 || g_probeNoReadback) g_pipeline = false;

    InitializeCriticalSection(&g_clockCs);
    LARGE_INTEGER f;
    QueryPerformanceFrequency(&f);
    g_freq = f.QuadPart;
    g_stepTicks = g_freq / 60 / stepDiv;
    if (g_stepTicks < 1) g_stepTicks = 1;

    bool okQpc = HookIATEntry("KERNEL32.dll", "QueryPerformanceCounter",
                              (void*)MyQueryPerformanceCounter, (void**)&g_origQPC);
    bool okTgt = HookIATEntry("WINMM.dll", "timeGetTime", (void*)MyTimeGetTime,
                              (void**)&g_origTimeGetTime);
    bool okTick = HookIATEntry("KERNEL32.dll", "GetTickCount", (void*)MyGetTickCount,
                               (void**)&g_origGetTickCount);
    bool okSleep = HookIATEntry("KERNEL32.dll", "Sleep", (void*)MySleep, (void**)&g_origSleep);
    InitializeCriticalSection(&g_threadCs);
    HookIATEntry("KERNEL32.dll", "CreateThread", (void*)MyCreateThread, (void**)&g_origCreateThread);

    HookVpatchModule("vpatch_th06.dll");
    HookVpatchModule("vpatch_th10.dll");

    // 音声(FRAME_SYNC_AUDIO設定時だけ)。DirectSoundの作成より前に登録しておく。
    InstallFrameSyncAudio();

    g_d3d9PrePresentCallback = OnPrePresent;
    g_d3d9PostPresentCallback = OnPostPresent;
    g_d3d8PrePresentCallback = OnPrePresentD3D8;
    g_d3d8PostPresentCallback = OnPostPresent;
    g_active = true;
    Log("InstallFrameSyncHook: QPC %s, timeGetTime %s, GetTickCount %s, Sleep %s, pipe=%s",
        okQpc ? "OK" : "not imported", okTgt ? "OK" : "not imported",
        okTick ? "OK" : "not imported", okSleep ? "OK" : "not imported", g_pipePath);
    Log("InstallFrameSyncHook: pipeline=%d skip_present=%d probe_readback2=%d "
        "probe_no_readback=%d", g_pipeline ? 1 : 0,
        g_skipPresent ? 1 : 0, g_probeReadback2 ? 1 : 0, g_probeNoReadback ? 1 : 0);
    return true;
}

} // namespace autoplay
