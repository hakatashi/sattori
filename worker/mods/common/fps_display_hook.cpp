#include "fps_display_hook.h"
#include "logging.h"
#include <stdlib.h>

namespace autoplay {

typedef BOOL(WINAPI* QueryPerformanceCounter_t)(LARGE_INTEGER* lpPerformanceCount);

static QueryPerformanceCounter_t g_origQPC = nullptr;
static double g_scale = 1.0;
static bool g_epochSet = false;
static LARGE_INTEGER g_epoch = {0};

// reports/48参照: mods/common/timer_probe_hook.*での実測により特定した、
// th20.exeのfpsカウンター表示計算に使われていると実証されたQueryPerformanceCounter
// 呼び出し元のRVA。th20.exeバイナリ固有(フレームごとに3回呼ばれる呼び出し元で、
// 同じくフレームごとに正確に1回だけ呼ばれる別の呼び出し元(rva=0x00141875、
// 恐らく内部フレームペーシング/自己スロットル用)を誤って対象にした初回実装では
// 表示は変化しなかった。さらにその0x00141875側を含め全呼び出し元を無差別に
// 時刻偽装する実験ではth20がハング(GetDeviceStateポーリングが完全停止)した
// ため、対象呼び出し元を1つに限定する現在の実装が安全性の面でも重要)。
static const ULONG_PTR kTargetRva = 0x0001cb54;

static BOOL WINAPI MyQueryPerformanceCounter(LARGE_INTEGER* lpPerformanceCount) {
    LARGE_INTEGER real;
    BOOL ok = g_origQPC(&real);
    if (!ok || !lpPerformanceCount) return ok;

    void* retAddr = __builtin_return_address(0);
    HMODULE hExe = GetModuleHandle(NULL);
    ULONG_PTR rva = (ULONG_PTR)retAddr - (ULONG_PTR)hExe;

    if (g_scale != 1.0 && rva == kTargetRva) {
        if (!g_epochSet) {
            g_epoch = real;
            g_epochSet = true;
        }
        LONGLONG realDelta = real.QuadPart - g_epoch.QuadPart;
        LONGLONG fakeDelta = (LONGLONG)(realDelta * g_scale);
        lpPerformanceCount->QuadPart = g_epoch.QuadPart + fakeDelta;
    } else {
        *lpPerformanceCount = real;
    }
    return ok;
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

bool InstallFpsDisplayCorrectionHook() {
    double targetHz = 60.0;
    const char* env = getenv("FPS_LIMIT_TARGET_HZ");
    if (env) {
        double hz = atof(env);
        if (hz > 0.0) targetHz = hz;
    }
    // 実際に間引かれたPresent間隔(targetHzが低いほど長い)を、th20自身の
    // fps計算からは「短い間隔」に見せかけて等倍相当のfps値を表示させたい。
    // よってscaleはtargetHz/60.0(30fps時0.5)であり、fps_limiter_hookの
    // targetIntervalSec(1.0/targetHz、間隔を伸ばす方向)とは逆方向になる。
    g_scale = targetHz / 60.0;

    bool ok = HookIATEntry("KERNEL32.dll", "QueryPerformanceCounter",
                            (void*)MyQueryPerformanceCounter, (void**)&g_origQPC);
    Log("InstallFpsDisplayCorrectionHook: IAT hook %s (scale=%.4f, targetRva=0x%08lx)",
        ok ? "OK" : "FAILED", g_scale, (unsigned long)kTargetRva);
    return ok;
}

} // namespace autoplay
