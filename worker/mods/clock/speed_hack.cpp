#include "clock/speed_hack.h"
#include "clock/time_warp.h"
#include "core/log.h"
#include "core/pe_iat.h"
#include "core/runtime_config.h"

namespace autoplay {

typedef BOOL(WINAPI* QueryPerformanceCounter_t)(LARGE_INTEGER* lpPerformanceCount);

typedef DWORD(WINAPI* timeGetTime_t)();

static QueryPerformanceCounter_t g_origQPC = nullptr;
static timeGetTime_t g_origTimeGetTime = nullptr;
static double g_speedMultiplier = 1.0;
static LONGLONG g_baseReal = 0;
static bool g_haveBase = false;

static BOOL WINAPI MyQueryPerformanceCounter(LARGE_INTEGER* lpPerformanceCount) {
    // NULLを渡されたら元の関数の挙動に任せる(自前の変数で呼んでから書き込むと、
    // 元の関数なら返せたはずのエラーの代わりにこちらでアクセス違反になる)。
    if (!lpPerformanceCount) return g_origQPC(lpPerformanceCount);
    LARGE_INTEGER real;
    BOOL ok = g_origQPC(&real);
    if (!ok) return ok;

    // 基準時刻は通常InitBases()(DLL_PROCESS_ATTACH中、単一スレッド)で確定済み。
    // ここは確定前に呼ばれた場合の保険。
    if (!g_haveBase) {
        g_baseReal = real.QuadPart;
        g_haveBase = true;
    }
    lpPerformanceCount->QuadPart = time_warp::Counter(g_baseReal, real.QuadPart, g_speedMultiplier);
    return TRUE;
}

// timeGetTime(ミリ秒カウンタ)も同じ考え方で伸長する(touhou-recorder reports/89)。
// timeGetTimeでフレーム時刻を測るタイトル向けに、GetProcAddressフック経由
// (WrapTimeGetTimeForSpeedHack)でだけ差し込む。基準は最初の呼び出し時刻。
static DWORD g_baseTgt = 0;
static bool g_haveBaseTgt = false;

static DWORD WINAPI MyTimeGetTime() {
    DWORD real = g_origTimeGetTime();
    if (!g_haveBaseTgt) { g_baseTgt = real; g_haveBaseTgt = true; }
    return time_warp::Millis(g_baseTgt, real, g_speedMultiplier);
}

// 基準時刻を、フックを差し込む時点(DLL_PROCESS_ATTACH中＝ローダーロック下の単一スレッド、
// またはGetProcAddressフック内)で確定させる。初回呼び出し時に遅延初期化すると、ゲームの
// 複数スレッドが同時に初めて呼んだ場合に基準の書き込みが競合し、32bitでは64bit値の読み書きが
// 分断されうる(基準がずれるとゲーム内時間が跳ぶ)。
static void InitBases() {
    if (g_origQPC && !g_haveBase) {
        LARGE_INTEGER real;
        if (g_origQPC(&real)) {
            g_baseReal = real.QuadPart;
            g_haveBase = true;
        }
    }
    if (g_origTimeGetTime && !g_haveBaseTgt) {
        g_baseTgt = g_origTimeGetTime();
        g_haveBaseTgt = true;
    }
}

void* WrapQueryPerformanceCounterForSpeedHack(void* real) {
    if (g_speedMultiplier == 1.0 || !real) return real;
    if (!g_origQPC) g_origQPC = (QueryPerformanceCounter_t)real;
    InitBases();
    return (void*)MyQueryPerformanceCounter;
}

void* WrapTimeGetTimeForSpeedHack(void* real) {
    if (g_speedMultiplier == 1.0 || !real) return real;
    if (!g_origTimeGetTime) g_origTimeGetTime = (timeGetTime_t)real;
    InitBases();
    return (void*)MyTimeGetTime;
}

bool InstallSpeedHackHook() {
    if (Config().FrameSyncEnabled()) {
        Log("InstallSpeedHackHook: フレーム同期有効のためスキップ(no-op)");
        return true;
    }
    const double multiplier = Config().speedHackMultiplier;
    g_speedMultiplier = multiplier;

    if (multiplier == 1.0) {
        Log("InstallSpeedHackHook: multiplier=1.0 のためスキップ(no-op)");
        return true;
    }

    bool ok = iat::HookTyped(nullptr, "KERNEL32.dll", "QueryPerformanceCounter",
                             &MyQueryPerformanceCounter, &g_origQPC);
    InitBases();
    Log("InstallSpeedHackHook: QPC hook %s (multiplier=%.2f)", ok ? "OK" : "FAILED", multiplier);
    return ok;
}

} // namespace autoplay
