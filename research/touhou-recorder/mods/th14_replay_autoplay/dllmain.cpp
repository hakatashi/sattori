// th14 (東方輝針城 ～ Double Dealing Character.、ver1.00b・非Steam版) replay auto-play MOD.
//
// th14.exeに注入し、タイトル画面のロード後に
//   Down x3 -> Enter(Replay) -> Right(ユーザーリプレイタブ) -> Enter(先頭スロット選択) -> Enter(再生)
// を自動で行う。Extraモード未解放のため「Extra Start」はスキップされ、Replayへは
// Down x3になる(ユーザー指定)。th14.exeはDINPUT8/DSOUND/d3d9をインポートしており、
// th13/th15と同じくGetDeviceStateで入力を読むためPressKey(DIKコード)で注入する(reports/103)。
//
// th14はcfg/replayを%APPDATA%/ShanghaiAlice/th14/から読む(recorder側のappdata_dirで配置)。
// リプレイは"th14_ud0000.rpy"に正規化して置くこと。
// 起動直後はロード中画面がタイトル画面と誤認されうるため、入力開始まで10秒待つ。
//
// スコア監視のアドレスはthprac_th14.cppより(score=0x4f5830、stage=0x4f58a4、
// lives=0x4f5864、graze=0x4f5840。スコアは内部値=表示値の1/10)。

#include <windows.h>
#include <stdlib.h>
#include "../common/dinput_hook.h"
#include "../common/window_wait.h"
#include "../common/logging.h"
#include "../common/speed_hack_hook.h"
#include "../common/frame_sync_hook.h"
#include "../common/dsound_probe_hook.h"
#include "../common/fps_monitor.h"
#include "../common/fps_limiter_hook.h"
#include "../common/dsound_hook.h"
#include "../common/fps_display_hook.h"
#include "../common/score_monitor.h"
#include "../common/d3d9_probe_hook.h"
#include "../common/d3dx_filter_hook.h"
#include "../common/timer_probe_hook.h"

using namespace autoplay;

// DirectInput scan codes.
static const BYTE DIK_DOWN = 0xD0;
static const BYTE DIK_RIGHT = 0xCD;
static const BYTE DIK_RETURN = 0x1C;

// 低速・倍速録画ではゲーム進行が FPS_LIMIT_TARGET_HZ/60 倍になるため、メニュー操作の
// 待ち時間も同じ比率で伸縮する(th13/th15と同じ)。MOD_MENU_TIME_SCALEで明示的に上書きできる。
static double GetMenuTimeScale() {
    if (const char* m = getenv("MOD_MENU_TIME_SCALE")) {
        double v = atof(m);
        if (v > 0.0) return v;
    }
    double targetHz = 60.0;
    const char* env = getenv("FPS_LIMIT_TARGET_HZ");
    if (env) {
        double hz = atof(env);
        if (hz > 0.0) targetHz = hz;
    }
    return 60.0 / targetHz;
}

static void ScaledSleep(DWORD baseMs) {
    if (FrameSyncActive()) {
        FrameSyncSleepMs(baseMs);
        return;
    }
    static double scale = GetMenuTimeScale();
    Sleep((DWORD)(baseMs * scale));
}

static DWORD WINAPI AutoPlayThread(LPVOID) {
    Log("=== th14_replay_autoplay: AutoPlayThread started ===");

    DWORD pid = GetCurrentProcessId();
    HWND hwnd = WaitForStableWindow(pid, /*stableMs=*/800, /*timeoutMs=*/30000);
    if (!hwnd) {
        Log("ERROR: game window never appeared, aborting sequence");
        return 1;
    }

    if (!WaitForHookActive(/*timeoutMs=*/30000)) {
        Log("ERROR: neither GetDeviceState nor GetKeyboardState hook was ever called, aborting sequence");
        return 1;
    }

    Log("Buffering 10000ms (scaled) for title screen load...");
    ScaledSleep(10000);

    Log("Step 1: Down x3 (select 'Replay' on main menu)");
    for (int i = 0; i < 3; i++) {
        PressKey(DIK_DOWN);
        ScaledSleep(250);
    }

    Log("Step 2: Enter (confirm 'Replay', enter replay list)");
    PressKey(DIK_RETURN);
    ScaledSleep(700);

    Log("Step 3: Right (switch to user replay tab)");
    PressKey(DIK_RIGHT);
    ScaledSleep(500);

    // リプレイは"th14_ud0000.rpy"として置かれている前提(ユーザーリプレイタブの先頭スロット)。
    Log("Step 4: Enter (select 1st user replay file)");
    PressKey(DIK_RETURN);
    ScaledSleep(700);

    Log("Step 5: Enter (confirm playback, start replay)");
    PressKey(DIK_RETURN);
    ScaledSleep(700);

    FrameSyncSetUnthrottled(true);

    Log("=== th14_replay_autoplay: sequence complete ===");
    return 0;
}

BOOL WINAPI DllMain(HINSTANCE hinst, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(hinst);
        LogInit(hinst, "th14_autoplay.log");
        Log("DLL_PROCESS_ATTACH: installing IAT hooks");
        InstallDinputHook();
        // 倍速録画(reports/89): SPEED_HACK_MULTIPLIER未設定(等倍・低速)なら何もしない。
        InstallSpeedHackHook();
        // フレーム同期キャプチャ(reports/110)。InstallFpsLimiterHookより前に呼ぶ。
        InstallFrameSyncHook();
        InstallKeyboardStateHook();
        // D3D9の描画記録(reports/99)。D3D9_PROBE未設定なら何もしない。
        InstallD3D9ProbeHook();
        // D3DXLoadSurfaceFromMemoryの縮小フィルタの補完(reports/101)。環境変数が未設定なら何もしない。
        InstallD3DXFilterHook();
        // 低速録画。FPS_LIMIT_TARGET_HZ未設定時は60Hzで従来動作と互換。
        InstallFpsLimiterHook(60.0);
        InstallDSoundHook(1.0);
        InstallDSoundProbeHook();
        // 低速録画で画面上のfps表示が低いままになる問題の補正(th15と同じ構造、reports/93・103)。
        // fpsの更新(0x2e4d0)が時刻取得関数(0x6ac20)を呼ぶ経路(戻り先0x2e4e0)だけを偽装する。
        // 0x6ac20内のQueryPerformanceCounterの戻り先は0x6ac5e。等倍・倍速では倍率1.0で無効。
        // InstallSpeedHackHookより後に呼ぶこと。TIMER_PROBE=1(呼び出し元調査)のときは
        // 同じIATスロットの二重フックを避けるため入れない(reports/48)。
        if (getenv("TIMER_PROBE")) {
            InstallTimerProbeHook();
        } else {
            InstallFpsDisplayCorrectionHookViaCaller(0x0006ac5e, 0x0002e4e0);
        }
        // リプレイずれ判定用のスコア等サンプリング(thprac_th14.cpp、image base 0x400000)。
        //   score: 0x4f5830 (+0x00、表示値の1/10)
        //   graze: 0x4f5840 (+0x10)
        //   lives: 0x4f5864 (+0x34)
        //   stage: 0x4f58a4 (+0x74)
        {
            ScoreMonitorConfig sm;
            sm.baseRva = 0xf5830;
            sm.baseIsPointer = false;
            sm.scoreOffset = 0x00;
            sm.scoreWidth = 4;
            sm.stageOffset = 0x74;
            sm.stageWidth = 4;
            sm.livesOffset = 0x34;
            sm.livesWidth = 4;
            sm.grazeOffset = 0x10;
            sm.grazeWidth = 4;
            sm.intervalMs = 1000;
            StartScoreMonitorThread(sm);
        }
        StartFpsMonitorThread();
        CreateThread(NULL, 0, AutoPlayThread, NULL, 0, NULL);
    }
    return TRUE;
}
