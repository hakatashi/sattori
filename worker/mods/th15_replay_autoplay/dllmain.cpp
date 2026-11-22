// th15 (東方紺珠伝 / Legacy of Lunatic Kingdom, TH15) replay auto-play MOD.
//
// Injects into th15.exe and, after the title screen finishes loading,
// automatically navigates: MainMenu -> Replay -> (user replay tab) ->
// (1st user replay file) -> (confirm playback), with no user interaction
// required.
//
// th15は960p相当の内部描画解像度(1280x960ウィンドウ)を持つth20と同世代の
// エンジンだが、**入力ポーリング方式はth11/th20のGetKeyboardStateではなく
// th06/07/08/10と同じDirectInputのGetDeviceStateである**ことを実機検証で確認した
// (touhou-recorder reports/82)。「TH10以降のエンジンはGetKeyboardState」という
// 既存の経験則(th20導入時のコメント)はth15には当てはまらないため、PressVKeyでは
// なくth10と同じPressKey(DIKスキャンコード経由)を使う。
//
// メニュー操作シーケンスはth20と同じ構造(Replay選択 -> ユーザー枠タブへRight ->
// 1件目を選択 -> 再生確定)だが、th15はExtra Startが常にグレーアウトしている
// (未クリア救済措置が無い)ため、Down x2でReplayへ到達する(th20はDown x3)。
//
// リプレイ一覧はth11/th20と同じ_udタブ方式で、ファイル名の数字サフィックスが
// スロットを決める(th15_ud0000.rpy -> スロット"No.0000")ため、呼び出し側
// (record_th15.py)は投入リプレイをこの名前へ正規化すること。

#include <windows.h>
#include <stdlib.h>
#include "audio/dsound.h"
#include "autoplay/window_wait.h"
#include "clock/fps_display.h"
#include "clock/speed_hack.h"
#include "core/log.h"
#include "core/runtime_config.h"
#include "core/time_scale.h"
#include "input/dinput.h"
#include "monitor/score_monitor.h"
#include "present/capture/d3d9_readback.h"
#include "present/capture/frame_sync.h"
#include "present/limiter.h"

using namespace autoplay;

// DirectInput scan codes.
static const BYTE DIK_DOWN = 0xD0;
static const BYTE DIK_RIGHT = 0xCD;
static const BYTE DIK_RETURN = 0x1C;

static DWORD WINAPI AutoPlayThread(LPVOID) {
    Log("=== th15_replay_autoplay: AutoPlayThread started ===");

    DWORD pid = GetCurrentProcessId();
    HWND hwnd = WaitForStableWindow(pid, /*stableMs=*/800, /*timeoutMs=*/time_scale::StartupTimeout(30000));
    if (!hwnd) {
        Log("ERROR: game window never appeared, aborting sequence");
        return 1;
    }

    if (!WaitForHookActive(/*timeoutMs=*/time_scale::StartupTimeout(30000))) {
        Log("ERROR: GetDeviceState hook was never called, aborting sequence");
        return 1;
    }

    // th20と同じ10秒。短くした5秒では1/3倍速の`c7i.4xlarge`でメニュー操作を取りこぼした(Issue #316)。
    // この区間は配信版でカットされる(`recording/cut.py`)ので、長くても動画には残らない。
    const DWORD titleWaitMs = frame_sync::Active() ? 11500 : 10000;
    Log("Buffering %lums (scaled) for title screen logo animation...", (unsigned long)titleWaitMs);
    time_scale::MenuSleep(titleWaitMs);

    LogStep(1, "Down x2 (select 'Replay' on main menu, skipping grayed-out 'Extra Start')");
    for (int i = 0; i < 2; i++) {
        PressKey(DIK_DOWN);
        time_scale::MenuSleep(250);
    }

    LogStep(2, "Enter (confirm 'Replay', enter replay list)");
    PressKey(DIK_RETURN);
    time_scale::MenuSleep(700);

    LogStep(3, "Right (switch to user replay tab)");
    PressKey(DIK_RIGHT);
    time_scale::MenuSleep(500);

    LogStep(4, "Enter (select 1st user replay file)");
    PressKey(DIK_RETURN);
    time_scale::MenuSleep(700);

    LogStep(5, "Enter (confirm playback, start replay from Stage 1)");
    PressKey(DIK_RETURN);
    time_scale::MenuSleep(700);

    frame_sync::SetUnthrottled(true);
    LogSequenceComplete("th15");
    return 0;
}

BOOL WINAPI DllMain(HINSTANCE hinst, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(hinst);
        LogInit(hinst, "th15_autoplay.log");
        InitRuntimeConfig();
        Log("DLL_PROCESS_ATTACH: installing IAT hooks");
        InstallDinputHook();
        if (!InstallFrameSyncD3D9(1024)) {
            // 倍速録画(reports/85・89): QPCの経過時間をSPEED_HACK_MULTIPLIER倍に伸ばす。
            // 未設定(等倍)なら何もしない。
            InstallSpeedHackHook();
            // 低速録画(Issue #316)対応。D3D9 Presentフックでフレームレートを制限する
            // (th20と同じ経路、touhou-recorder reports/82で動作確認済み)。
            InstallFpsLimiterHook();
            // 低速録画でfps表示が低いままになる問題の補正(touhou-recorder reports/93)。FPSInfの
            // 更新(0x335f0)が時刻取得関数(0x72c90)を呼ぶ経路だけを偽装する。0x72c90はフレーム
            // ペーシング等と共有なのでQPCの戻り先だけでは絞り込めない。等倍・倍速録画では倍率
            // 1.0となり無効。IATの外側に置くためInstallSpeedHackHookより後に呼ぶこと。
            InstallFpsDisplayCorrectionHookViaCaller(0x00072ccb, 0x00033600);
        }
        // present/limiterによる映像・ゲームロジックのスローモーション化は
        // DirectSoundのBGM/SEストリーミングには連動しないため、SetFrequency
        // フックで音声側も同じ比率でスケールする(th20と同じ理由)。
        InstallDSoundHook();
        // リプレイずれ判定用のスコア等サンプリング(Issue #103)。RVAはthprac
        // (thprac_th15.cpp)のth15_patch_mainフック内の絶対アドレス書き込み
        // (0x4E740C=score/10, 0x4E7450=life, 0x4E741C=graze)から、th15.exeの
        // ImageBase(0x400000、標準)を基点にRVA化したもの
        // (touhou-recorder reports/82)。score(内部値)は画面表示値の1/10
        // (th07/th08/th10/th11/th20と同じ×10系列)。ステージ番号を保持する
        // 単純な変数はthprac_th15.cpp全体を確認した範囲では見つからなかった
        // (CalcSection()による区間IDの動的計算のみ)ため、stageWidthは未指定
        // (=監視しない)。フル尺録画でリプレイ記録スコアとの完全一致を実機
        // 検証済み(reports/82)。
        {
            ScoreMonitorConfig sm;
            sm.baseRva = 0xE7400;
            sm.baseIsPointer = false;
            sm.scoreOffset = 0x0C;
            sm.scoreWidth = 4;
            sm.livesOffset = 0x50;
            sm.livesWidth = 4;
            sm.grazeOffset = 0x1C;
            sm.grazeWidth = 4;
            sm.intervalMs = 1000;
            StartScoreMonitorThread(sm);
        }
        CreateThread(NULL, 0, AutoPlayThread, NULL, 0, NULL);
    }
    return TRUE;
}
