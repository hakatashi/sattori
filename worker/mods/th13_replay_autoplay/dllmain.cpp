// th13(東方神霊廟 ～ Ten Desires.、ver1.00c・非Steam版)の自動再生MOD。
//
// メインメニュー -> Replay -> (ユーザーリプレイタブへ切替) -> (1番目選択) -> (再生確定)
// を自動操作する(touhou-recorder reports/100で実機検証済みのMODを移植したもの)。
//
// - 入力注入経路はth10/th12/th128と同じDirectInput GetDeviceState(PressKey、DIKコード)。
//   MODログのFpsMonitorでGetDeviceStateが60Hzで呼ばれることを確認済み(reports/100)。
// - メインメニューの「Extra Start」は未解放だとカーソルが飛ばすため、ReplayへはDown x3で
//   着地する。スコアファイル(scoreth13.dat)の無いまっさらな状態を前提にしているので、
//   **Extraを解放したスコアファイルをタイトル資産に入れないこと**(worker/docs/titles/th13.md)。
// - 起動直後のロード中画面をタイトル画面と取り違えないよう、入力開始まで10秒待つ。
// - リプレイは"th13_ud0000.rpy"として%APPDATA%/ShanghaiAlice/th13/replay/に置かれている
//   前提(record_th13.pyのcanonical_slotとuses_appdata_profile)。

#include <windows.h>
#include <stdlib.h>
#include "../common/dinput_hook.h"
#include "../common/window_wait.h"
#include "../common/logging.h"
#include "../common/speed_hack_hook.h"
#include "../common/fps_monitor.h"
#include "../common/fps_limiter_hook.h"
#include "../common/dsound_hook.h"
#include "../common/score_monitor.h"

using namespace autoplay;

// DirectInput scan codes.
static const BYTE DIK_DOWN = 0xD0;
static const BYTE DIK_RIGHT = 0xCD;
static const BYTE DIK_RETURN = 0x1C;

// 低速録画(FPS_LIMIT_TARGET_HZ<60)ではメニューの画面遷移もゲーム内時間で遅くなるため、
// 待ち時間を60/FPS_LIMIT_TARGET_HZ倍に伸ばす(th128と同じ)。等倍・未設定なら1.0。
static double GetMenuTimeScale() {
    double targetHz = 60.0;
    const char* env = getenv("FPS_LIMIT_TARGET_HZ");
    if (env) {
        double hz = atof(env);
        if (hz > 0.0) targetHz = hz;
    }
    return 60.0 / targetHz;
}

static void ScaledSleep(DWORD baseMs) {
    static double scale = GetMenuTimeScale();
    Sleep((DWORD)(baseMs * scale));
}

static DWORD WINAPI AutoPlayThread(LPVOID) {
    Log("=== th13_replay_autoplay: AutoPlayThread started ===");

    DWORD pid = GetCurrentProcessId();
    HWND hwnd = WaitForStableWindow(pid, /*stableMs=*/800, /*timeoutMs=*/30000);
    if (!hwnd) {
        Log("ERROR: game window never appeared, aborting sequence");
        return 1;
    }

    if (!WaitForHookActive(/*timeoutMs=*/30000)) {
        Log("ERROR: GetDeviceState hook was never called, aborting sequence");
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

    Log("Step 4: Enter (select 1st user replay file)");
    PressKey(DIK_RETURN);
    ScaledSleep(700);

    Log("Step 5: Enter (confirm playback, start replay)");
    PressKey(DIK_RETURN);
    ScaledSleep(700);

    Log("=== th13_replay_autoplay: sequence complete ===");
    return 0;
}

BOOL WINAPI DllMain(HINSTANCE hinst, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(hinst);
        LogInit(hinst, "th13_autoplay.log");
        Log("DLL_PROCESS_ATTACH: installing IAT hooks");
        InstallDinputHook();
        // QPC偽装。等倍では何もしない。低速録画ではワーカーがSPEED_HACK_MULTIPLIER<1を渡す
        // (record_th13.pyのslow_motion_speed_hack)。ゲーム自身のフレーム待ちと画面右下の
        // fps表示がQPC基準なので、Presentの上限と揃えて減速すると表示も「60.0fps」のままになる
        // (reports/100の1/2倍速の録画で確認、worker/docs/titles/th13.md)。
        InstallSpeedHackHook();
        // VsyncPatchを使わないので、等倍でもPresentを60fpsに制限する(th10・th128と同じ。
        // FPS_LIMIT_TARGET_HZがあればそちらを優先する)。
        InstallFpsLimiterHook(60.0);
        // BGM/SEの再生周波数をFPS_LIMIT_TARGET_HZ/60倍にスケールし(等倍なら無変更)、
        // A/V同期マーカー(reports/88)を有効にする。
        InstallDSoundHook(1.0);
        // リプレイずれ判定用のスコア等サンプリング(Issue #103)。RVAはthprac
        // (thprac_th13.cpp)の絶対VAからimage base(0x400000)を引いたもの:
        //   score: 0x4be7c0 (+0x00、内部値=表示値の1/10)
        //   stage: 0x4be81c (+0x5c、1始まり。Extraは7)
        //   lives: 0x4be7f4 (+0x34)
        //   graze: 0x4be7d0 (+0x10)
        // 通常(Hard全クリア)・Extraのフル尺録画で記録スコアとの完全一致を確認済み(reports/100)。
        {
            ScoreMonitorConfig sm;
            sm.baseRva = 0xbe7c0;
            sm.baseIsPointer = false;
            sm.scoreOffset = 0x00;
            sm.scoreWidth = 4;
            sm.stageOffset = 0x5c;
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
