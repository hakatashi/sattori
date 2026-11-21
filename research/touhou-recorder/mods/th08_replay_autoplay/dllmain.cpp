// th08 (Imperishable Night / Eiyashou / TH08) replay auto-play MOD.
//
// Injects into TH08.EXE and, after the title screen finishes loading,
// automatically navigates: MainMenu -> Replay -> (1st replay file) ->
// (default start stage) -> (normal playback mode), with no user
// interaction required.
//
// Identical in structure to mods/th07_replay_autoplay/dllmain.cpp; the only
// functional difference is the number of Down presses needed to reach
// "Replay" on th08's main menu (2, per the current game config).
//
// See docs/touhou_menu_automation.md for the technical background
// (DirectInput GetDeviceState vtable hook) and reports/08_*.md for the
// verification log of this specific MOD.

#include <windows.h>
#include <stdlib.h>
#include "../common/dinput_hook.h"
#include "../common/window_wait.h"
#include "../common/logging.h"
#include "../common/speed_hack_hook.h"
#include "../common/frame_sync_hook.h"
#include "../common/fps_limiter_hook_d3d8.h"
#include "../common/dsound_hook.h"
#include "../common/dsound_probe_hook.h"
#include "../common/fps_display_hook.h"
#include "../common/fps_monitor.h"
#include "../common/stage_probe_hook.h"
#include "../common/stage_marker_hook.h"
#include "../common/score_monitor.h"

using namespace autoplay;

// DirectInput scan codes.
static const BYTE DIK_DOWN = 0xD0;
static const BYTE DIK_RETURN = 0x1C;

static void ScaledSleep(DWORD baseMs) {
    if (FrameSyncActive()) {
        FrameSyncSleepMs(baseMs);
        return;
    }
    Sleep(baseMs);
}

static DWORD WINAPI AutoPlayThread(LPVOID) {
    Log("=== th08_replay_autoplay: AutoPlayThread started ===");

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

    Log("Buffering 1500ms for title screen animation...");
    ScaledSleep(1500);

    Log("Step 1: Down x2 (select 'Replay' on main menu)");
    for (int i = 0; i < 2; i++) {
        PressKey(DIK_DOWN);
        ScaledSleep(250);
    }

    Log("Step 2: Enter (confirm 'Replay', enter replay list)");
    PressKey(DIK_RETURN);
    ScaledSleep(700);

    Log("Step 3: Enter (select 1st replay file)");
    PressKey(DIK_RETURN);
    ScaledSleep(700);

    Log("Step 4: Enter (select default start stage)");
    PressKey(DIK_RETURN);
    ScaledSleep(700);

    Log("Step 5: Enter (select normal playback mode, start replay)");
    PressKey(DIK_RETURN);
    // th08のステージ番号変数はメニュー中から既に1面相当(0)のため、リプレイ開始時に
    // 「値の変化」が起きず1面のマーカーが取れない。ここで補助マーカーを出す(フェーズ49)。
    LogReplayStartMarker();
    ScaledSleep(700);

    FrameSyncSetUnthrottled(true);

    Log("=== th08_replay_autoplay: sequence complete ===");
    return 0;
}

BOOL WINAPI DllMain(HINSTANCE hinst, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(hinst);
        LogInit(hinst, "th08_autoplay.log");
        Log("DLL_PROCESS_ATTACH: installing IAT hook");
        InstallDinputHook();
        // 倍速録画(reports/89): SPEED_HACK_MULTIPLIER未設定(等倍・低速)なら何もしない。
        InstallSpeedHackHook();
        // フレーム同期キャプチャ(reports/111)。th08のメインループは1フレーム待ちに
        // PeekMessageA+TestCooperativeLevel+QPCを使うため、step_div=32で回転数を抑える。
        InstallFrameSyncHook(32);
        InstallFpsLimiterHookD3D8(60.0);
        // BGM/SEの再生周波数をFPS_LIMIT_TARGET_HZ/60倍にスケールし(等倍なら無変更)、
        // A/V同期マーカー(reports/88)を有効にする。
        InstallDSoundHook(1.0);
        InstallDSoundProbeHook();
        // 画面上fpsカウンター表示の倍速・低速録画補正(reports/90)。th08(ver1.00d)の
        // fps計算(書式"%.02ffps"、RVA 0x47031で参照)はWINMM.dll!timeGetTimeで経過時間を
        // 測る(0x46fa7=初回のみ基準時刻、0x46fb2=毎フレーム現在時刻、500ms毎に更新)。
        // speed_hack_hookはQPCしか偽装しないため、2倍速では「120.00fps」と表示されていた。
        static const ULONG_PTR kFpsTimeRvas[] = {0x00046fad, 0x00046fb8};
        InstallFpsDisplayCorrectionHookTimeGetTime(kFpsTimeRvas, 2);
        // ステージ開始検出手段の調査用(STAGE_PROBE=1のときのみ有効、フェーズ49)
        InstallStageProbeHook();
        // ステージ番号変数のRVAは未特定のため、STAGE_MARKER_RVA環境変数での指定時のみ有効。
        InstallStageMarkerHook(0x000e4850, /*width=*/4, /*stageBase=*/1);
        // リプレイずれ判定用のスコア等サンプリング(フェーズ53)。RVAはthprac
        // (thprac_th08.cpp)の`GetMemAddr`ヘルパが辿るプレイヤー状態構造体への
        // ポインタ変数(絶対VA 0x160f510、RVA=0x120f510)由来。1段階のポインタ
        // 間接参照が必要。score/graze(いずれもint32)は、フル尺録画での実機
        // 検証の結果、**画面表示値の1/10**であることを確認済み(th07/th11/th20
        // と同じ慣習。th8_06.rpyで内部値119,697,060×10=1,196,970,600が
        // リプレイの記録スコアと完全一致することを確認、
        // reports/53_phase53_score_monitor_all_titles.md参照)。導入当初は
        // 「th06と同じく等倍」と予想していたが誤りだった。life(float、
        // 破片管理)。ステージ番号はこの構造体には無く、上記の
        // InstallStageMarkerHookが別途扱う。
        {
            ScoreMonitorConfig sm;
            sm.baseRva = 0x120f510;
            sm.baseIsPointer = true;
            sm.scoreOffset = 0x00;
            sm.scoreWidth = 4;
            sm.livesOffset = 0x74;
            sm.livesWidth = 4;
            sm.livesIsFloat = true;
            sm.grazeOffset = 0x04;
            sm.grazeWidth = 4;
            sm.intervalMs = 1000;
            StartScoreMonitorThread(sm);
        }
        StartFpsMonitorThread();
        CreateThread(NULL, 0, AutoPlayThread, NULL, 0, NULL);
    }
    return TRUE;
}
