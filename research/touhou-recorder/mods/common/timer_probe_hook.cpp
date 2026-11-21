#include "timer_probe_hook.h"
#include "logging.h"
#include <stdlib.h>

namespace autoplay {

typedef BOOL(WINAPI* QueryPerformanceCounter_t)(LARGE_INTEGER* lpPerformanceCount);
typedef DWORD(WINAPI* timeGetTime_t)();
typedef void(WINAPI* GetSystemTimeAsFileTime_t)(FILETIME* lpSystemTimeAsFileTime);
typedef UINT_PTR(WINAPI* SetTimer_t)(HWND hWnd, UINT_PTR nIDEvent, UINT uElapse, void* lpTimerFunc);

static QueryPerformanceCounter_t g_origQPC = nullptr;
static timeGetTime_t g_origTimeGetTime = nullptr;
static GetSystemTimeAsFileTime_t g_origGetSystemTimeAsFileTime = nullptr;
static SetTimer_t g_origSetTimer = nullptr;

// 呼び出し元(return address)ごとの呼び出し回数を記録する簡易テーブル。
// 診断用途のみで多少のレースは許容する(InterlockedIncrementのみ使用)。
struct CallSite {
    void* addr;
    LONG count;
};

static const int kMaxSites = 64;
static CallSite g_qpcSites[kMaxSites] = {};
static CallSite g_timeSites[kMaxSites] = {};

static void RecordCallSite(CallSite* table, void* retAddr) {
    for (int i = 0; i < kMaxSites; i++) {
        if (table[i].addr == retAddr) {
            InterlockedIncrement(&table[i].count);
            return;
        }
        if (table[i].addr == nullptr) {
            // 競合時に多少ズレても診断用途としては問題ない。
            table[i].addr = retAddr;
            InterlockedIncrement(&table[i].count);
            return;
        }
    }
}

static BOOL WINAPI MyQueryPerformanceCounter(LARGE_INTEGER* lpPerformanceCount) {
    void* retAddr = __builtin_return_address(0);
    RecordCallSite(g_qpcSites, retAddr);
    return g_origQPC(lpPerformanceCount);
}

static DWORD WINAPI MyTimeGetTime() {
    void* retAddr = __builtin_return_address(0);
    RecordCallSite(g_timeSites, retAddr);
    return g_origTimeGetTime();
}

static CallSite g_gstSites[kMaxSites] = {};

static void WINAPI MyGetSystemTimeAsFileTime(FILETIME* lpSystemTimeAsFileTime) {
    void* retAddr = __builtin_return_address(0);
    RecordCallSite(g_gstSites, retAddr);
    g_origGetSystemTimeAsFileTime(lpSystemTimeAsFileTime);
}

static UINT_PTR WINAPI MySetTimer(HWND hWnd, UINT_PTR nIDEvent, UINT uElapse, void* lpTimerFunc) {
    void* retAddr = __builtin_return_address(0);
    HMODULE hExe = GetModuleHandle(NULL);
    Log("TimerProbe: SetTimer called rva=0x%08lx id=%llu elapse=%u",
        (unsigned long)((BYTE*)retAddr - (BYTE*)hExe), (unsigned long long)nIDEvent, uElapse);
    return g_origSetTimer(hWnd, nIDEvent, uElapse, lpTimerFunc);
}

static bool HookIATEntry(const char* dllName, const char* funcName, void* newFunc,
                          void** outOld) {
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

static DWORD WINAPI TimerProbeReportThread(LPVOID) {
    HMODULE hExe = GetModuleHandle(NULL);
    BYTE* base = (BYTE*)hExe;
    for (;;) {
        Sleep(2000);
        Log("TimerProbe: --- QueryPerformanceCounter call sites (rva, count) ---");
        for (int i = 0; i < kMaxSites && g_qpcSites[i].addr; i++) {
            Log("TimerProbe: QPC rva=0x%08lx count=%ld",
                (unsigned long)((BYTE*)g_qpcSites[i].addr - base), g_qpcSites[i].count);
        }
        Log("TimerProbe: --- timeGetTime call sites (rva, count) ---");
        for (int i = 0; i < kMaxSites && g_timeSites[i].addr; i++) {
            Log("TimerProbe: TGT rva=0x%08lx count=%ld",
                (unsigned long)((BYTE*)g_timeSites[i].addr - base), g_timeSites[i].count);
        }
        Log("TimerProbe: --- GetSystemTimeAsFileTime call sites (rva, count) ---");
        for (int i = 0; i < kMaxSites && g_gstSites[i].addr; i++) {
            Log("TimerProbe: GST rva=0x%08lx count=%ld",
                (unsigned long)((BYTE*)g_gstSites[i].addr - base), g_gstSites[i].count);
        }
    }
    return 0;
}

void InstallTimerProbeHook() {
    const char* env = getenv("TIMER_PROBE");
    if (!env || atoi(env) == 0) return;

    bool okQpc = HookIATEntry("KERNEL32.dll", "QueryPerformanceCounter",
                               (void*)MyQueryPerformanceCounter, (void**)&g_origQPC);
    bool okTgt = HookIATEntry("WINMM.dll", "timeGetTime", (void*)MyTimeGetTime,
                               (void**)&g_origTimeGetTime);
    bool okGst = HookIATEntry("KERNEL32.dll", "GetSystemTimeAsFileTime",
                               (void*)MyGetSystemTimeAsFileTime,
                               (void**)&g_origGetSystemTimeAsFileTime);
    bool okTimer = HookIATEntry("USER32.dll", "SetTimer", (void*)MySetTimer,
                                 (void**)&g_origSetTimer);
    Log("InstallTimerProbeHook: QPC hook %s, timeGetTime hook %s, GST hook %s, SetTimer hook %s",
        okQpc ? "OK" : "FAILED", okTgt ? "OK" : "FAILED", okGst ? "OK" : "FAILED",
        okTimer ? "OK" : "FAILED");

    CreateThread(NULL, 0, TimerProbeReportThread, NULL, 0, NULL);
}

} // namespace autoplay
