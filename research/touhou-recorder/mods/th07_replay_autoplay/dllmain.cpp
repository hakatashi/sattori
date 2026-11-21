// th07 (East New World / Youyoumu / TH07) replay auto-play MOD.
//
// Injects into th07.exe and, after the title screen finishes loading,
// automatically navigates: MainMenu -> Replay -> (1st replay file) ->
// (default start stage) -> (normal playback mode), with no user
// interaction required.
//
// See docs/touhou_menu_automation.md for the technical background
// (DirectInput GetDeviceState vtable hook) and reports/07_*.md for the
// verification log of this specific MOD.

#include <windows.h>
#include <stdlib.h>
#include "../common/dinput_hook.h"
#include "../common/window_wait.h"
#include "../common/logging.h"
#include "../common/fps_monitor.h"
#include "../common/speed_hack_hook.h"
#include "../common/frame_sync_hook.h"
#include "../common/fps_limiter_hook_d3d8.h"
#include "../common/dsound_hook.h"
#include "../common/dsound_probe_hook.h"
#include "../common/stage_probe_hook.h"
#include "../common/stage_marker_hook.h"
#include "../common/score_monitor.h"
#include "../common/score_probe_hook.h"

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
    Log("=== th07_replay_autoplay: AutoPlayThread started ===");

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

    // フェーズ54: sattori本番が使うth07.exe ver1.00b(games/th07_ver100b)では
    // メインメニューの項目構成がtouhou-recorderの旧検証環境(ver1.00、
    // 607744バイト)と異なり、Down x3ではなく**Down x2**で「Replay」に到達する
    // (sattori側worker/mods/th07_replay_autoplay/dllmain.cppで確認済みの値)。
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
    ScaledSleep(700);

    FrameSyncSetUnthrottled(true);

    Log("=== th07_replay_autoplay: sequence complete ===");
    return 0;
}

BOOL WINAPI DllMain(HINSTANCE hinst, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(hinst);
        LogInit(hinst, "th07_autoplay.log");
        Log("DLL_PROCESS_ATTACH: installing IAT hook");
        InstallDinputHook();
        // 倍速録画(reports/89): SPEED_HACK_MULTIPLIER未設定(等倍・低速)なら何もしない。
        InstallSpeedHackHook();
        // フレーム同期キャプチャ(reports/111)。th07のメインループは1フレーム待ちに
        // PeekMessageA+TestCooperativeLevel+QPCを使うため、step_div=32で回転数を抑える。
        InstallFrameSyncHook(32);
        InstallFpsLimiterHookD3D8(60.0);
        // BGM/SEの再生周波数をFPS_LIMIT_TARGET_HZ/60倍にスケールし(等倍なら無変更)、
        // A/V同期マーカー(reports/88)を有効にする。
        InstallDSoundHook(1.0);
        InstallDSoundProbeHook();
        // ステージ開始検出手段の調査用(STAGE_PROBE=1のときのみ有効、フェーズ49)
        InstallStageProbeHook();
        // スコア変数RVA調査用(SCORE_PROBE=1のときのみ有効、フェーズ53、用済みで削除予定)
        InstallScoreProbeHook();
        // フェーズ54: sattori本番が配布しているth07.exeはver1.00b(650752バイト、
        // games/th07_ver100b)であり、touhou-recorderが当初の検証(フェーズ49・53)
        // に使っていたth07.exe(607744バイト、公式パッチ未適用の旧バージョン、
        // games/th07/)とはバイナリレベルで別物と判明した(sattori側の移植検証で
        // 発覚)。**以下のRVAは全てver1.00b向けに再特定したもの**であり、旧
        // バイナリ向けのRVA(フェーズ49の0x0022583c等)とは異なる。旧バイナリ用の
        // 値は使わないこと。
        //
        // ステージ開始時刻の記録(フェーズ49で確立した手法をver1.00bに再適用、
        // フェーズ54)。RVAは差分スキャン(SCORE_PROBE版の手法を流用、
        // scripts/49_stage_probe_run.py --game th07 --replay th7_09.rpy
        // --duration 600で取得したログをBGMトラック切り替え時刻(t≈188.3s/427.4s、
        // th7_09.rpyの2面・3面境界)と突き合わせ)で特定した、th07.exeの現在
        // ステージ番号(1始まり)を保持する静的変数。**このRVAは下記
        // GAME_MANAGER(thprac記載の絶対VA0x626270、RVA=0x226270)+0x95ecの
        // stageフィールドと完全に一致する**ことを実測で確認できた(つまり
        // ver1.00bについてはthprac記載のGAME_MANAGER位置がそのまま正しい)。
        InstallStageMarkerHook(0x0022f85c, /*width=*/4);
        // 弾幕パターン(通常弾幕・スペルカード)開始の記録。フェーズ49で旧
        // バイナリ向けに特定したRVA(0x00095bec)はver1.00bでは未検証・おそらく
        // 無効(GAME_MANAGER自体のRVAが変わっているため)。ver1.00b向けの
        // 再特定は未実施(スコープ外、必要になったら差分スキャンで再調査すること)。
        InstallPatternMarkerHook(0x00095bec);
        // スペルカード発動中フラグ。同上、ver1.00b向けの再特定は未実施。
        InstallSpellFlagMarkerHook(0x005ac82b);
        // リプレイずれ判定用のスコア等サンプリング(フェーズ53でth07全般に導入、
        // フェーズ54でver1.00b向けに修正)。**thprac(thprac_th07.cpp)記載の
        // `GAME_MANAGER = (GameManager*)0x626270`(絶対VA、RVA=0x226270)は、
        // ver1.00bに対してはそのまま正しいことが実測で確認できた**(上記の
        // stageマーカーRVAとの整合性で裏付け済み)。フェーズ53時点では旧
        // バイナリ(607744バイト)向けに0x0021c250へ補正していたが、これは
        // 誤ったバイナリに対する補正であり、ver1.00bには適用してはならない。
        // true_score(int32, Globals+0x4)は画面表示値の1/10(th11/th20と同じ
        // 慣習、@sattori/touhou-replay-parserの`score = raw * 10`に対応)。
        // フェーズ54時点ではver1.00bでのフル尺録画による完全一致検証は未実施
        // (短時間録画でのオーダー確認のみ)。life_countはfloat(破片管理のため)。
        // ステージ番号はこの構造体には無く、上記のInstallStageMarkerHookが
        // 別途扱う。
        {
            ScoreMonitorConfig sm;
            sm.baseRva = 0x226270 + 0x8; // GAME_MANAGER(thprac記載どおり、ver1.00bで実測確認済み)->globals フィールド
            sm.baseIsPointer = true;
            sm.scoreOffset = 0x04; // true_score
            sm.scoreWidth = 4;
            sm.livesOffset = 0x5c; // life_count
            sm.livesWidth = 4;
            sm.livesIsFloat = true;
            sm.grazeOffset = 0x18;
            sm.grazeWidth = 4;
            sm.intervalMs = 1000;
            StartScoreMonitorThread(sm);
        }
        // 倍速録画の進行速度確認用(reports/89)。
        StartFpsMonitorThread();
        CreateThread(NULL, 0, AutoPlayThread, NULL, 0, NULL);
    }
    return TRUE;
}
