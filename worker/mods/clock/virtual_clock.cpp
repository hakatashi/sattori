#include "clock/virtual_clock.h"

#include <string.h>

#include "clock/virtual_clock_math.h"
#include "core/log.h"
#include "core/pe_iat.h"
#include "core/runtime_config.h"

namespace autoplay::virtual_clock {

namespace {

typedef BOOL(WINAPI* QueryPerformanceCounter_t)(LARGE_INTEGER*);
typedef DWORD(WINAPI* timeGetTime_t)();
typedef DWORD(WINAPI* GetTickCount_t)();
typedef ULONGLONG(WINAPI* GetTickCount64_t)();
typedef void(WINAPI* Sleep_t)(DWORD);
typedef HANDLE(WINAPI* CreateThread_t)(LPSECURITY_ATTRIBUTES, SIZE_T, LPTHREAD_START_ROUTINE,
                                       LPVOID, DWORD, LPDWORD);
typedef HANDLE(WINAPI* CreateWaitableTimerExW_t)(LPSECURITY_ATTRIBUTES, LPCWSTR, DWORD, DWORD);
typedef HANDLE(WINAPI* CreateWaitableTimerW_t)(LPSECURITY_ATTRIBUTES, BOOL, LPCWSTR);
typedef HANDLE(WINAPI* CreateWaitableTimerA_t)(LPSECURITY_ATTRIBUTES, BOOL, LPCSTR);
typedef BOOL(WINAPI* SetWaitableTimerEx_t)(HANDLE, const LARGE_INTEGER*, LONG, PTIMERAPCROUTINE,
                                           LPVOID, void*, ULONG);
typedef BOOL(WINAPI* SetWaitableTimer_t)(HANDLE, const LARGE_INTEGER*, LONG, PTIMERAPCROUTINE,
                                         LPVOID, BOOL);
typedef DWORD(WINAPI* WaitForSingleObject_t)(HANDLE, DWORD);

QueryPerformanceCounter_t g_origQPC = nullptr;
timeGetTime_t g_origTimeGetTime = nullptr;
GetTickCount_t g_origGetTickCount = nullptr;
GetTickCount64_t g_origGetTickCount64 = nullptr;
Sleep_t g_origSleep = nullptr;
CreateThread_t g_origCreateThread = nullptr;
CreateWaitableTimerExW_t g_origCreateWTExW = nullptr;
CreateWaitableTimerW_t g_origCreateWTW = nullptr;
CreateWaitableTimerA_t g_origCreateWTA = nullptr;
SetWaitableTimerEx_t g_origSetWTEx = nullptr;
SetWaitableTimer_t g_origSetWT = nullptr;
WaitForSingleObject_t g_origWFSO = nullptr;

bool g_active = false;
bool g_trackThreads = false;
bool g_silentInit = false;
volatile LONG g_virtualMode = 0;
DWORD g_mainThreadId = 0;
CRITICAL_SECTION g_clockCs;
LONGLONG g_freq = 0;
LONGLONG g_vt = 0;
LONGLONG g_vtBase = 0;
DWORD g_tgtBase = 0;
ULONGLONG g_tickBase64 = 0;
LONGLONG g_stepTicks = 0;
SleepFilter g_sleepFilter = nullptr;

// ---- waitable timer 追跡(vpatch の SleepType=1 や DXライブラリの VSync 待ち用) ----
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

LONGLONG ReadVirtual(LONGLONG advance) {
    EnterCriticalSection(&g_clockCs);
    g_vt += advance;
    LONGLONG v = g_vt;
    LeaveCriticalSection(&g_clockCs);
    return v;
}

BOOL WINAPI MyQueryPerformanceCounter(LARGE_INTEGER* out) {
    if (!g_virtualMode) return g_origQPC ? g_origQPC(out) : QueryPerformanceCounter(out);
    out->QuadPart = ReadVirtual(OnMainThread() ? g_stepTicks : 0);
    return TRUE;
}

DWORD WINAPI MyTimeGetTime() {
    // 直接 timeGetTime() を呼ぶと -lwinmm(WINMM.dll インポート)が増えるので g_origTimeGetTime 経由にする。
    if (!g_virtualMode) return g_origTimeGetTime ? g_origTimeGetTime() : 0;
    LONGLONG v = ReadVirtual(OnMainThread() ? g_stepTicks : 0);
    return g_tgtBase + (DWORD)TicksToMs(v - g_vtBase, g_freq);
}

DWORD WINAPI MyGetTickCount() {
    if (!g_virtualMode) return g_origGetTickCount ? g_origGetTickCount() : GetTickCount();
    LONGLONG v = ReadVirtual(OnMainThread() ? g_stepTicks : 0);
    return (DWORD)(g_tickBase64 + (ULONGLONG)TicksToMs(v - g_vtBase, g_freq));
}

ULONGLONG WINAPI MyGetTickCount64() {
    if (!g_virtualMode) {
        return g_origGetTickCount64 ? g_origGetTickCount64() : (ULONGLONG)GetTickCount();
    }
    LONGLONG v = ReadVirtual(OnMainThread() ? g_stepTicks : 0);
    return g_tickBase64 + (ULONGLONG)TicksToMs(v - g_vtBase, g_freq);
}

void WINAPI MySleep(DWORD ms) {
    if (g_sleepFilter && g_sleepFilter(ms)) return;
    if (!g_virtualMode || !OnMainThread()) {
        if (g_origSleep) g_origSleep(ms);
        else Sleep(ms);
        return;
    }
    if (ms > 0 && ms != INFINITE) ReadVirtual(MsToTicks(ms, g_freq));
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
                                 PTIMERAPCROUTINE comp, LPVOID arg, void* rc, ULONG tol) {
    TrackTimer(h);
    if (g_virtualMode && OnMainThread()) {
        if (pDue) {
            LONGLONG ticks = WaitableDueToTicks(pDue->QuadPart, g_freq);
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
        if (pDue) {
            LONGLONG ticks = WaitableDueToTicks(pDue->QuadPart, g_freq);
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

// ---- 実時間スレッドの追跡(touhou-recorder reports/107) ----
const int kMaxTracked = 64;
struct TrackedThread {
    HANDLE h;
    DWORD tid;
    DWORD startRva;
    LONGLONG createdFrame;
    LONGLONG createdReal;
};
TrackedThread g_tracked[kMaxTracked];
int g_nTracked = 0;
CRITICAL_SECTION g_threadCs;
LONGLONG g_presentCountForThreads = 0;

HANDLE WINAPI MyCreateThread(LPSECURITY_ATTRIBUTES sa, SIZE_T stack, LPTHREAD_START_ROUTINE fn,
                             LPVOID param, DWORD flags, LPDWORD tidOut) {
    DWORD tid = 0;
    HANDLE h = g_origCreateThread(sa, stack, fn, param, flags, &tid);
    if (tidOut) *tidOut = tid;
    DWORD rva = (DWORD)((BYTE*)fn - (BYTE*)GetModuleHandleA(nullptr));
    if (h && g_virtualMode) {
        HANDLE dup = nullptr;
        DuplicateHandle(GetCurrentProcess(), h, GetCurrentProcess(), &dup, SYNCHRONIZE, FALSE, 0);
        EnterCriticalSection(&g_threadCs);
        if (dup && g_nTracked < kMaxTracked) {
            g_tracked[g_nTracked++] = {dup, tid, rva, g_presentCountForThreads, RealNow()};
        } else if (dup) {
            CloseHandle(dup);
        }
        LeaveCriticalSection(&g_threadCs);
    }
    Log("FrameSync: CreateThread tid=%lu start=0x%lX frame=%lld virtual=%d", (unsigned long)tid,
        (unsigned long)rva, g_presentCountForThreads, (int)g_virtualMode);
    return h;
}

const int kNumVpatchModules = 4;
const char* const kVpatchModules[kNumVpatchModules] = {
    "vpatch_th06.dll",
    "vpatch_th07.dll",
    "vpatch_th10.dll",
    "vpatch_th12.dll",
};
bool g_vpatchHooked[kNumVpatchModules] = {};

void HookVpatchModules() {
    for (int i = 0; i < kNumVpatchModules; i++) {
        if (g_vpatchHooked[i]) continue;
        HMODULE hMod = GetModuleHandleA(kVpatchModules[i]);
        if (!hMod) continue;
        g_vpatchHooked[i] = true;
        bool q = iat::HookTyped(hMod, "KERNEL32.dll", "QueryPerformanceCounter",
                                &MyQueryPerformanceCounter, &g_origQPC);
        bool s = iat::HookTyped(hMod, "KERNEL32.dll", "Sleep", &MySleep, &g_origSleep);
        bool g = iat::HookTyped(hMod, "KERNEL32.dll", "GetTickCount", &MyGetTickCount,
                                &g_origGetTickCount);
        bool c = iat::HookTyped(hMod, "KERNEL32.dll", "CreateWaitableTimerA",
                                &MyCreateWaitableTimerA, &g_origCreateWTA);
        bool w = iat::HookTyped(hMod, "KERNEL32.dll", "SetWaitableTimer", &MySetWaitableTimer,
                                &g_origSetWT);
        bool f = iat::HookTyped(hMod, "KERNEL32.dll", "WaitForSingleObject", &MyWaitForSingleObject,
                                &g_origWFSO);
        if (!g_silentInit) {
            Log("FrameSync: hooked vpatch IAT (%s) QPC=%d Sleep=%d GTC=%d CreateWT=%d SetWT=%d "
                "WFSO=%d",
                kVpatchModules[i], q ? 1 : 0, s ? 1 : 0, g ? 1 : 0, c ? 1 : 0, w ? 1 : 0,
                f ? 1 : 0);
        }
    }
}

template <typename Fn>
void* WrapFunc(void* real, Fn hooked, Fn* origOut) {
    if (!g_active || !real) return real;
    if (!*origOut && real != (void*)hooked) *origOut = (Fn)real;
    return (void*)hooked;
}

}  // namespace

bool Install(const Options& options) {
    if (!Config().FrameSyncEnabled()) return false;
    if (g_active) return true;

    g_trackThreads = options.trackThreads;
    g_silentInit = options.silentInit;

    InitializeCriticalSection(&g_clockCs);
    if (g_trackThreads) InitializeCriticalSection(&g_threadCs);

    LARGE_INTEGER f = {};
    QueryPerformanceFrequency(&f);
    g_freq = f.QuadPart;
    int stepDiv = Config().FrameSyncStepDivOr(options.stepDiv);
    g_stepTicks = ComputeStepTicks(g_freq, stepDiv);

    bool okQpc = iat::HookTyped(nullptr, "KERNEL32.dll", "QueryPerformanceCounter",
                                &MyQueryPerformanceCounter, &g_origQPC);
    bool okTgt =
        iat::HookTyped(nullptr, "WINMM.dll", "timeGetTime", &MyTimeGetTime, &g_origTimeGetTime);
    bool okTick =
        iat::HookTyped(nullptr, "KERNEL32.dll", "GetTickCount", &MyGetTickCount, &g_origGetTickCount);
    iat::HookTyped(nullptr, "KERNEL32.dll", "GetTickCount64", &MyGetTickCount64,
                   &g_origGetTickCount64);
    bool okSleep = iat::HookTyped(nullptr, "KERNEL32.dll", "Sleep", &MySleep, &g_origSleep);

    if (options.hookWaitableTimers) {
        iat::HookTyped(nullptr, "KERNEL32.dll", "CreateWaitableTimerExW",
                       &MyCreateWaitableTimerExW, &g_origCreateWTExW);
        iat::HookTyped(nullptr, "KERNEL32.dll", "CreateWaitableTimerW", &MyCreateWaitableTimerW,
                       &g_origCreateWTW);
        iat::HookTyped(nullptr, "KERNEL32.dll", "CreateWaitableTimerA", &MyCreateWaitableTimerA,
                       &g_origCreateWTA);
        iat::HookTyped(nullptr, "KERNEL32.dll", "SetWaitableTimerEx", &MySetWaitableTimerEx,
                       &g_origSetWTEx);
        iat::HookTyped(nullptr, "KERNEL32.dll", "SetWaitableTimer", &MySetWaitableTimer,
                       &g_origSetWT);
        iat::HookTyped(nullptr, "KERNEL32.dll", "WaitForSingleObject", &MyWaitForSingleObject,
                       &g_origWFSO);
    }

    if (g_trackThreads) {
        iat::HookTyped(nullptr, "KERNEL32.dll", "CreateThread", &MyCreateThread,
                       &g_origCreateThread);
        HookVpatchModules();
    }

    g_active = true;
    if (!g_silentInit) {
        Log("InstallVirtualClock: QPC=%s timeGetTime=%s GetTickCount=%s Sleep=%s step_div=%d",
            okQpc ? "OK" : "not imported", okTgt ? "OK" : "not imported",
            okTick ? "OK" : "not imported", okSleep ? "OK" : "not imported", stepDiv);
    }
    return true;
}

bool IsActive() { return g_active; }

void Enter() {
    if (g_trackThreads) HookVpatchModules();
    g_mainThreadId = GetCurrentThreadId();
    g_vt = g_vtBase = RealNow();
    g_tgtBase = g_origTimeGetTime ? g_origTimeGetTime() : 0;
    g_tickBase64 = g_origGetTickCount64
                       ? g_origGetTickCount64()
                       : (ULONGLONG)(g_origGetTickCount ? g_origGetTickCount() : GetTickCount());
    InterlockedExchange(&g_virtualMode, 1);
    Log("FrameSync: virtual clock on (main thread id=%lu, step=%lld ticks, freq=%lld)",
        (unsigned long)g_mainThreadId, g_stepTicks, g_freq);
}

bool IsVirtualMode() { return g_virtualMode != 0; }

void AdvanceToFrame(LONGLONG frame) {
    EnterCriticalSection(&g_clockCs);
    LONGLONG minVt = FrameToMinVirtualTicks(g_vtBase, frame, g_freq);
    if (g_vt < minVt) g_vt = minVt;
    LeaveCriticalSection(&g_clockCs);
}

LONGLONG RealNow() {
    LARGE_INTEGER t = {};
    QueryPerformanceCounter(&t);
    return t.QuadPart;
}

LONGLONG Freq() { return g_freq; }

DWORD MainThreadId() { return g_mainThreadId; }

void RecordPresentFrame(LONGLONG frame) { g_presentCountForThreads = frame; }

int CountLiveThreads() {
    if (!g_trackThreads) return 0;
    LONGLONG now = RealNow();
    const double maxMs = (double)Config().frameSyncThreadMaxMs;
    int live = 0;
    EnterCriticalSection(&g_threadCs);
    for (int i = 0; i < g_nTracked;) {
        TrackedThread& t = g_tracked[i];
        double ms = (double)(now - t.createdReal) * 1000.0 / (double)g_freq;
        bool done = WaitForSingleObject(t.h, 0) == WAIT_OBJECT_0;
        if (done || ms > maxMs) {
            Log("FrameSync: thread tid=%lu start=0x%lX %s frames=%lld(%lld..%lld) real_ms=%.0f",
                (unsigned long)t.tid, (unsigned long)t.startRva,
                done ? "exited" : "untracked(long-lived)", g_presentCountForThreads - t.createdFrame,
                t.createdFrame, g_presentCountForThreads, ms);
            CloseHandle(t.h);
            g_tracked[i] = g_tracked[--g_nTracked];
            continue;
        }
        live++;
        i++;
    }
    LeaveCriticalSection(&g_threadCs);
    return live;
}

void SetSleepFilter(SleepFilter filter) { g_sleepFilter = filter; }

void* WrapQueryPerformanceCounter(void* real) {
    return WrapFunc(real, &MyQueryPerformanceCounter, &g_origQPC);
}
void* WrapTimeGetTime(void* real) { return WrapFunc(real, &MyTimeGetTime, &g_origTimeGetTime); }
void* WrapGetTickCount(void* real) { return WrapFunc(real, &MyGetTickCount, &g_origGetTickCount); }
void* WrapGetTickCount64(void* real) {
    return WrapFunc(real, &MyGetTickCount64, &g_origGetTickCount64);
}
void* WrapSleep(void* real) { return WrapFunc(real, &MySleep, &g_origSleep); }
void* WrapWaitForSingleObject(void* real) {
    return WrapFunc(real, &MyWaitForSingleObject, &g_origWFSO);
}

}  // namespace autoplay::virtual_clock
