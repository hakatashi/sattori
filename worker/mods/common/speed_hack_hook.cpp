#include "speed_hack_hook.h"
#include "logging.h"
#include <stdlib.h>
#include <string.h>

namespace autoplay {

typedef BOOL(WINAPI* QueryPerformanceCounter_t)(LARGE_INTEGER* lpPerformanceCount);

typedef DWORD(WINAPI* timeGetTime_t)();
typedef DWORD(WINAPI* GetTickCount_t)();

static QueryPerformanceCounter_t g_origQPC = nullptr;
static timeGetTime_t g_origTimeGetTime = nullptr;
static GetTickCount_t g_origGetTickCount = nullptr;
static double g_speedMultiplier = 1.0;
static LONGLONG g_baseReal = 0;
static bool g_haveBase = false;

static BOOL WINAPI MyQueryPerformanceCounter(LARGE_INTEGER* lpPerformanceCount) {
    LARGE_INTEGER real;
    BOOL ok = g_origQPC(&real);
    if (!ok) return ok;

    if (!g_haveBase) {
        g_baseReal = real.QuadPart;
        g_haveBase = true;
    }
    LONGLONG elapsedReal = real.QuadPart - g_baseReal;
    LONGLONG elapsedScaled = (LONGLONG)((double)elapsedReal * g_speedMultiplier);
    lpPerformanceCount->QuadPart = g_baseReal + elapsedScaled;
    return TRUE;
}

// timeGetTime / GetTickCount(ミリ秒カウンタ)も同じ考え方で伸長する(フェーズ89)。
// th10以前のタイトルはQPCではなくtimeGetTimeでフレーム時刻を測っている可能性があるため、
// exeがインポートしていれば両方フックする。基準はそれぞれ最初の呼び出し時刻。
static DWORD g_baseTgt = 0, g_baseTick = 0;
static bool g_haveBaseTgt = false, g_haveBaseTick = false;

static DWORD WINAPI MyTimeGetTime() {
    DWORD real = g_origTimeGetTime();
    if (!g_haveBaseTgt) { g_baseTgt = real; g_haveBaseTgt = true; }
    return g_baseTgt + (DWORD)((double)(DWORD)(real - g_baseTgt) * g_speedMultiplier);
}

static DWORD WINAPI MyGetTickCount() {
    DWORD real = g_origGetTickCount();
    if (!g_haveBaseTick) { g_baseTick = real; g_haveBaseTick = true; }
    return g_baseTick + (DWORD)((double)(DWORD)(real - g_baseTick) * g_speedMultiplier);
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

void* WrapQueryPerformanceCounterForSpeedHack(void* real) {
    if (g_speedMultiplier == 1.0) return real;
    if (!g_origQPC) g_origQPC = (QueryPerformanceCounter_t)real;
    return (void*)MyQueryPerformanceCounter;
}

void* WrapTimeGetTimeForSpeedHack(void* real) {
    if (g_speedMultiplier == 1.0) return real;
    if (!g_origTimeGetTime) g_origTimeGetTime = (timeGetTime_t)real;
    return (void*)MyTimeGetTime;
}

bool InstallSpeedHackHook(double multiplier) {
    const char* env = getenv("SPEED_HACK_MULTIPLIER");
    if (env) {
        double m = atof(env);
        if (m > 0.0) multiplier = m;
    }
    g_speedMultiplier = multiplier;

    if (multiplier == 1.0) {
        Log("InstallSpeedHackHook: multiplier=1.0 のためスキップ(no-op)");
        return true;
    }

    bool ok = HookIATEntry("KERNEL32.dll", "QueryPerformanceCounter",
                            (void*)MyQueryPerformanceCounter, (void**)&g_origQPC);
    // SPEED_HACK_TIMERS(カンマ区切り、既定"qpc")で偽装するタイマーを選ぶ。
    // 例: "qpc,tgt"(timeGetTimeも)、"qpc,tgt,tick"(GetTickCountも)。
    const char* timers = getenv("SPEED_HACK_TIMERS");
    bool tgt = timers && strstr(timers, "tgt");
    bool tick = timers && strstr(timers, "tick");
    bool okTgt = false, okTick = false;
    if (tgt)
        okTgt = HookIATEntry("WINMM.dll", "timeGetTime", (void*)MyTimeGetTime,
                             (void**)&g_origTimeGetTime);
    if (tick)
        okTick = HookIATEntry("KERNEL32.dll", "GetTickCount", (void*)MyGetTickCount,
                              (void**)&g_origGetTickCount);
    Log("InstallSpeedHackHook: QPC hook %s, timeGetTime hook %s, GetTickCount hook %s "
        "(multiplier=%.2f)",
        ok ? "OK" : "FAILED", tgt ? (okTgt ? "OK" : "FAILED") : "off",
        tick ? (okTick ? "OK" : "FAILED") : "off", multiplier);
    return ok || okTgt || okTick;
}

} // namespace autoplay
