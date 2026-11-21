// th09 (東方花映塚 / Phantasmagoria of Flower View / TH09) replay auto-play MOD.
//
// Injects into th09.exe and, after the title screen finishes loading,
// automatically navigates: MainMenu -> Replay -> (switch to user-replay tab)
// -> (1st replay file) -> (confirm playback), with no user interaction
// required.
//
// th09はth06/07/08と同じ世代のエンジンで、DirectInputのGetDeviceStateが
// 実ポーリング経路であることを前提にPressKey(DIKスキャンコード経由)を使う
// (th10/th12と同じ構成。th11/th20のGetKeyboardState方式ではない)。
//
// メニュー操作シーケンスはユーザー提供:
//   Down x2 -> Enter(「Replay」選択) -> [直ちにリプレイ選択画面へ遷移]
//   -> Right x1(ユーザーリプレイタブへ切替) -> Enter(1番目のリプレイ選択)
//   -> Enter(再生確定)
// th11/th12/th20と同じ「ud0000タブ」方式のため、scripts/25側でコピー先
// ファイル名を常に"th9_ud0000.rpy"に正規化する
// (GAME_CONFIGS["th09"]["replay_dest_filename"]参照)。

#include <windows.h>
#include <stdlib.h>
#include "../common/dinput_hook.h"
#include "../common/window_wait.h"
#include "../common/logging.h"
#include "../common/speed_hack_hook.h"
#include "../common/frame_sync_hook.h"
#include "../common/fps_monitor.h"
#include "../common/stage_probe_hook.h"
#include "../common/score_probe_hook.h"
#include "../common/stage_marker_hook.h"
#include "../common/score_monitor.h"
#include "../common/fps_limiter_hook_d3d8.h"
#include "../common/dsound_hook.h"
#include "../common/dsound_probe_hook.h"
#include "../common/fps_display_hook.h"

using namespace autoplay;

// DirectInput scan codes.
static const BYTE DIK_DOWN = 0xD0;
static const BYTE DIK_RIGHT = 0xCD;
static const BYTE DIK_RETURN = 0x1C;

// 低速録画(フェーズ68、th10/th12と同じ方式。fps_limiter_hook_d3d8.h参照)。
// FPS_LIMIT_TARGET_HZ未設定時はscale=1.0で従来動作と完全互換。
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
    if (FrameSyncActive()) {
        FrameSyncSleepMs(baseMs);
        return;
    }
    static double scale = GetMenuTimeScale();
    Sleep((DWORD)(baseMs * scale));
}

static DWORD WINAPI AutoPlayThread(LPVOID) {
    Log("=== th09_replay_autoplay: AutoPlayThread started ===");

    DWORD pid = GetCurrentProcessId();
    // 低速録画(FPS_LIMIT_TARGET_HZ<60)時は、fps_limiter_hook_d3d8のPresent
    // 間引き(Sleep+ビジーウェイト)がCPUを占有し、タイトル画面ロード完了までの
    // 実時間が通常より延びることを実機確認した(30fps設定でホスト高負荷時に
    // 30秒を超えることがあった)。他の待機と同様ScaledSleepと同じ比率で延長する。
    HWND hwnd = WaitForStableWindow(pid, /*stableMs=*/800,
                                     /*timeoutMs=*/(DWORD)(30000 * GetMenuTimeScale()));
    if (!hwnd) {
        Log("ERROR: game window never appeared, aborting sequence");
        return 1;
    }

    if (!WaitForHookActive(/*timeoutMs=*/(DWORD)(30000 * GetMenuTimeScale()))) {
        Log("ERROR: GetDeviceState hook was never called, aborting sequence");
        return 1;
    }

    Log("Buffering 1500ms (scaled) for title screen animation...");
    ScaledSleep(1500);

    Log("Step 1: Down x2 (select 'Replay' on main menu)");
    for (int i = 0; i < 2; i++) {
        PressKey(DIK_DOWN);
        ScaledSleep(250);
    }

    Log("Step 2: Enter (confirm 'Replay', enter replay list)");
    PressKey(DIK_RETURN);
    ScaledSleep(700);

    Log("Step 3: Right (switch to user-replay tab)");
    PressKey(DIK_RIGHT);
    ScaledSleep(400);

    Log("Step 4: Enter (select 1st replay file)");
    PressKey(DIK_RETURN);
    ScaledSleep(700);

    Log("Step 5: Enter (confirm playback, start replay)");
    PressKey(DIK_RETURN);
    LogReplayStartMarker();
    ScaledSleep(700);

    FrameSyncSetUnthrottled(true);

    Log("=== th09_replay_autoplay: sequence complete ===");
    return 0;
}

BOOL WINAPI DllMain(HINSTANCE hinst, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(hinst);
        LogInit(hinst, "th09_autoplay.log");
        Log("DLL_PROCESS_ATTACH: installing IAT hook");
        InstallDinputHook();
        // 倍速録画(reports/89): SPEED_HACK_MULTIPLIER未設定(等倍・低速)なら何もしない。
        InstallSpeedHackHook();
        // フレーム同期キャプチャ(reports/111)。th09のメインループは1フレーム待ちに
        // PeekMessageA+TestCooperativeLevel+QPCを使うため、step_div=32で回転数を抑える。
        InstallFrameSyncHook(32);
        // 低速録画(フェーズ68)。th09はDirect3D8エンジンのため、th10/th12
        // (Direct3D9)向けのfps_limiter_hook.hではなくD3D8版
        // (fps_limiter_hook_d3d8.h、vtable番号の根拠は同ヘッダのコメント参照)を
        // 使う。FPS_LIMIT_TARGET_HZ未設定時はscale=1.0で従来動作と完全互換。
        InstallFpsLimiterHookD3D8(60.0);
        InstallDSoundHook(1.0);
        InstallDSoundProbeHook();
        // 低速録画時の画面上fpsカウンター表示補正(フェーズ69、reports/48のth20と
        // 同じ手法)。th09は`mods/common/timer_probe_hook.*`による調査の結果、
        // th20と異なりQueryPerformanceCounterではなくWINMM.dll!timeGetTime
        // (rva=0x00031701、Present呼び出し頻度と1:1で相関する唯一の持続的な
        // timeGetTime呼び出し元)がfps表示計算に使われていることが判明した
        // (QueryPerformanceCounterの持続的な呼び出し元は1箇所のみで60Hz固定
        // ・throttleの影響を受けず、fps表示用ではないと判断)。実機で
        // FPS_LIMIT_TARGET_HZ=30設定時に画面上fps表示が「60.00fps」に変わる
        // ことを確認済み(GetDeviceStateポーリング頻度・ゲーム進行速度には
        // 影響なし)。FPS_LIMIT_TARGET_HZ未設定時はscale=1.0で実質無効化。
        InstallFpsDisplayCorrectionHookTimeGetTime(0x00031701);
        // ステージ開始検出手段の調査用(STAGE_PROBE=1のときのみ有効)。
        InstallStageProbeHook();
        // スコアRVA探索用の使い捨て診断フック(SCORE_PROBE=1のときのみ有効)。
        // thprac(thprac_th09.cpp)のTH09Toolsにはscore表示が無く、既知のRVAが
        // 無いため、プレイヤー構造体ポインタ(絶対VA 0x4a7d94=P1、0x4a7dcc=P2、
        // RVA=0xa7d94/0xa7dcc)を起点にSCORE_PROBE_PTR_RVAで間接参照して
        // 構造体内(既知のlifeオフセット0xa8より手前を含む0x0〜0x30400)を
        // スキャンする(フェーズ68)。
        InstallScoreProbeHook();
        // P1残機の監視(フェーズ68)。スコアはpl1/pl2構造体(0x30400バイト全域)
        // ・弾幕マネージャ構造体(3MB)・0x4a0000-0x4e5000のBSS領域いずれを
        // int32/int64/floatで全探索してもRealtime表示値(1x/10x/±50許容)と
        // 一致する場所が見つからず、未特定のまま(scoreWidth=0で無効化、
        // reports/68参照)。lifeはthprac(thprac_th09.cpp)のTH09Toolsで
        // pl1+0xa8として確認済みのRVA(絶対VA 0x4a7d94経由のポインタ間接参照、
        // 値は0.5刻みの残機を2倍した整数、1〜10)。P2側は未監視(単一のstage/
        // lives/graze欄しか持たないScoreMonitorConfigの構造上、両者を同時に
        // 出すには別途拡張が必要なため今回は自分側=P1のみ)。
        {
            ScoreMonitorConfig sm;
            sm.baseRva = 0xa7d94;
            sm.baseIsPointer = true;
            sm.scoreWidth = 0;
            sm.livesOffset = 0xa8;
            sm.livesWidth = 4;
            sm.intervalMs = 1000;
            StartScoreMonitorThread(sm);
        }
        StartFpsMonitorThread();
        CreateThread(NULL, 0, AutoPlayThread, NULL, 0, NULL);
    }
    return TRUE;
}
