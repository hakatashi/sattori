#include "clock/fps_display.h"
#include "clock/time_warp.h"
#include "core/log.h"
#include "core/pe_iat.h"
#include "core/runtime_config.h"

namespace autoplay {

typedef BOOL(WINAPI* QueryPerformanceCounter_t)(LARGE_INTEGER* lpPerformanceCount);

static QueryPerformanceCounter_t g_origQPC = nullptr;
static double g_scale = 1.0;
static bool g_epochSet = false;
static LARGE_INTEGER g_epoch = {};

// reports/48参照: touhou-recorder の mods/common/timer_probe_hook.*での実測により特定した、対象
// ゲームのfpsカウンター表示計算に使われていると実証されたQueryPerformanceCounter
// 呼び出し元のRVA(InstallFpsDisplayCorrectionHookの引数で指定、ゲームバイナリ
// 固有)。th20の調査では、フレームごとに正確に1回だけ呼ばれる別の呼び出し元
// (恐らく内部フレームペーシング/自己スロットル用)を誤って対象にした初回実装
// では表示は変化しなかった。さらにその呼び出し元を含め全QueryPerformanceCounter
// 呼び出し元を無差別に時刻偽装する実験ではth20がハング(GetDeviceStateポーリング
// が完全停止)したため、対象呼び出し元を限定する現在の実装は安全性の面でも重要。
//
// 対象呼び出し元は複数指定できる(th06/th08は「初回だけ基準時刻を取る呼び出し」と
// 「毎フレーム現在時刻を取る呼び出し」の2箇所で経過時間を測るため、両方を同じ
// 写像で偽装する必要がある、reports/90)。
static const int kMaxRvas = 4;
static ULONG_PTR g_targetRvas[kMaxRvas] = {0};
static int g_numTargetRvas = 0;
// 0以外なら、対象呼び出し元のさらに呼び出し元も一致するときだけ偽装する(th15、reports/93)。
static ULONG_PTR g_callerReturnRva = 0;

static bool RvaMatches(const ULONG_PTR* rvas, int n, ULONG_PTR rva) {
    for (int i = 0; i < n; i++)
        if (rvas[i] == rva) return true;
    return false;
}

// fps表示の補正倍率。表示計算が見る時間の進み方を「実時間×FPS_LIMIT_TARGET_HZ/60」に
// したい(実フレームレートがtargetHzのとき表示を60にする)。ただし倍速録画
// (SPEED_HACK_MULTIPLIER=m、reports/89)では、clock/speed_hackが同じAPIを先にIATフック
// して既にm倍に伸長した値を返しているため、本フックが受け取る値は実時間×mになっている。
// そのまま targetHz/60 を掛けると二重掛けになり、2倍速(targetHz=120, m=2)でth12/th20の
// 表示が「30fps」になっていた(reports/90)。伸長済みの分をmで割り戻す。
// speedHacked: 対象APIをclock/speed_hackが偽装しているか(QPCは倍率≠1なら常に、
// timeGetTimeは、IATフックでは偽装されない(GetProcAddress経由のWrapTimeGetTimeForSpeedHack
// だけで偽装され、本フックはIATに入れるため常にfalse))。
static double ComputeDisplayScale(bool speedHacked) {
    const RuntimeConfig& c = Config();
    double scale = c.TargetHzOr(60.0) / 60.0;
    if (speedHacked && c.speedHackMultiplier != 1.0) scale /= c.speedHackMultiplier;
    return scale;
}

static BOOL WINAPI MyQueryPerformanceCounter(LARGE_INTEGER* lpPerformanceCount) {
    LARGE_INTEGER real;
    BOOL ok = g_origQPC(&real);
    if (!ok || !lpPerformanceCount) return ok;

    void* retAddr = __builtin_return_address(0);
    HMODULE hExe = GetModuleHandle(NULL);
    ULONG_PTR rva = (ULONG_PTR)retAddr - (ULONG_PTR)hExe;

    bool target = g_scale != 1.0 && RvaMatches(g_targetRvas, g_numTargetRvas, rva);
    if (target && g_callerReturnRva) {
        // 自分のフレームの保存EBP=対象呼び出し元のEBP。その+4がさらに呼び出し元への戻り先。
        void** callerFrame = *(void***)__builtin_frame_address(0);
        target = (ULONG_PTR)callerFrame[1] - (ULONG_PTR)hExe == g_callerReturnRva;
    }
    if (target) {
        if (!g_epochSet) {
            g_epoch = real;
            g_epochSet = true;
        }
        lpPerformanceCount->QuadPart = time_warp::Counter(g_epoch.QuadPart, real.QuadPart, g_scale);
    } else {
        *lpPerformanceCount = real;
    }
    return ok;
}

// timeGetTime版(th09、フェーズ69。th06/th08、reports/90)。QueryPerformanceCounter版とは
// 独立した状態・IATスロットを使う。
typedef DWORD(WINAPI* timeGetTime_t)();
static timeGetTime_t g_origTimeGetTime = nullptr;
static double g_scaleTgt = 1.0;
static bool g_epochSetTgt = false;
static DWORD g_epochTgt = 0;
static ULONG_PTR g_targetRvasTgt[kMaxRvas] = {0};
static int g_numTargetRvasTgt = 0;

static DWORD WINAPI MyTimeGetTime() {
    DWORD real = g_origTimeGetTime();

    void* retAddr = __builtin_return_address(0);
    HMODULE hExe = GetModuleHandle(NULL);
    ULONG_PTR rva = (ULONG_PTR)retAddr - (ULONG_PTR)hExe;

    if (g_scaleTgt != 1.0 && RvaMatches(g_targetRvasTgt, g_numTargetRvasTgt, rva)) {
        if (!g_epochSetTgt) {
            g_epochTgt = real;
            g_epochSetTgt = true;
        }
        return time_warp::Millis(g_epochTgt, real, g_scaleTgt);
    }
    return real;
}

static int CopyRvas(ULONG_PTR* dst, const ULONG_PTR* src, int n) {
    if (n > kMaxRvas) n = kMaxRvas;
    for (int i = 0; i < n; i++) dst[i] = src[i];
    return n;
}

bool InstallFpsDisplayCorrectionHookTimeGetTime(const ULONG_PTR* targetRvas, int numRvas) {
    if (Config().FrameSyncEnabled()) {
        Log("InstallFpsDisplayCorrectionHookTimeGetTime: フレーム同期有効のためスキップ(no-op)");
        return true;
    }
    g_numTargetRvasTgt = CopyRvas(g_targetRvasTgt, targetRvas, numRvas);
    g_scaleTgt = ComputeDisplayScale(/*speedHacked=*/false);

    bool ok = iat::HookTyped(nullptr, "WINMM.dll", "timeGetTime", &MyTimeGetTime, &g_origTimeGetTime);
    Log("InstallFpsDisplayCorrectionHookTimeGetTime: IAT hook %s (scale=%.4f, targetRva=0x%08lx, "
        "n=%d)",
        ok ? "OK" : "FAILED", g_scaleTgt, (unsigned long)g_targetRvasTgt[0], g_numTargetRvasTgt);
    return ok;
}

bool InstallFpsDisplayCorrectionHookTimeGetTime(ULONG_PTR targetRva) {
    return InstallFpsDisplayCorrectionHookTimeGetTime(&targetRva, 1);
}

bool InstallFpsDisplayCorrectionHook(const ULONG_PTR* targetRvas, int numRvas) {
    if (Config().FrameSyncEnabled()) {
        Log("InstallFpsDisplayCorrectionHook: フレーム同期有効のためスキップ(no-op)");
        return true;
    }
    g_numTargetRvas = CopyRvas(g_targetRvas, targetRvas, numRvas);
    // 実際に間引かれたPresent間隔(targetHzが低いほど長い)を、ゲーム自身の
    // fps計算からは「短い間隔」に見せかけて等倍相当のfps値を表示させたい。
    // よってscaleはtargetHz/60.0(30fps時0.5)であり、present/limiterの
    // targetIntervalSec(1.0/targetHz、間隔を伸ばす方向)とは逆方向になる。
    // QPCは倍速録画時は常にclock/speed_hackが偽装済みなので、その分を割り戻す。
    g_scale = ComputeDisplayScale(/*speedHacked=*/true);

    bool ok = iat::HookTyped(nullptr, "KERNEL32.dll", "QueryPerformanceCounter",
                             &MyQueryPerformanceCounter, &g_origQPC);
    Log("InstallFpsDisplayCorrectionHook: IAT hook %s (scale=%.4f, targetRva=0x%08lx, n=%d)",
        ok ? "OK" : "FAILED", g_scale, (unsigned long)g_targetRvas[0], g_numTargetRvas);
    return ok;
}

bool InstallFpsDisplayCorrectionHook(ULONG_PTR targetRva) {
    return InstallFpsDisplayCorrectionHook(&targetRva, 1);
}

bool InstallFpsDisplayCorrectionHookViaCaller(ULONG_PTR qpcReturnRva, ULONG_PTR callerReturnRva) {
    g_callerReturnRva = callerReturnRva;
    return InstallFpsDisplayCorrectionHook(&qpcReturnRva, 1);
}

} // namespace autoplay
