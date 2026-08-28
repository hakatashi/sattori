// th10 (東方風神録 / Mountain of Faith, TH10) replay auto-play MOD.
//
// Injects into th10.exe and, after the title screen finishes loading,
// automatically navigates: MainMenu -> Replay -> (1st replay file) ->
// (confirm playback), with no user interaction required.
//
// th10.exeはth11/th20と異なり、TH10エンジン初出のこのタイトルではまだ
// GetKeyboardState方式に切り替わっておらず、DirectInputのGetDeviceStateが
// 実際に56〜60Hzでポーリングされる(FpsMonitorログで確認、touhou-recorder
// reports/56)。そのためth06/07/08と同じPressKey(DIKスキャンコード経由)を
// 使う(InstallKeyboardStateHookは不要)。
//
// タイトル画面は「10th Project Shrine Maiden」ロゴの後に"PRESS ANY BUTTON"
// 表示が続き、Enterで消してメインメニューへ進む(th06/07/08には無いステップ)。
// 実機診断で判明した重要な点: タイトルロゴ演出中に送った入力はバッファされず
// 単純に無視され、早すぎるEnterはタイトル消しに失敗する。失敗した状態で後続の
// Down/Enterを送ると、それらが「まだ表示されているPRESS ANY BUTTON」を消す
// 動作+メインメニューの項目確定に化けてしまい、Game Start等の別ルート
// (Rank Select/Player Select)に迷い込む。6000ms待つことで安定してタイトルを
// 消せることを確認済み(touhou-recorder reports/56・59)。
//
// メインメニューは Game Start / Extra Start / Practice Start / Replay /
// Player Data / Music Room / Option / Quit の8項目が常に表示されるが、
// Extra Startはカーソル移動時に自動スキップされる(実機確認: Down x1で
// Practice Start、Down x2でReplayにカーソルが移動する)。
//
// リプレイ一覧は th06/07/08 と同じ単純な番号スロット方式で、ファイル名の
// 数字がそのままスロット番号(No.NN)になる(th11/th20の_udタブ切替は無い)。
// このMODは常に「1番目のスロット(No.01)」を選ぶ固定シーケンスのため、
// record_th10.py側でコピー先ファイル名を"th10_01.rpy"に正規化する。

#include <windows.h>
#include "../common/dinput_hook.h"
#include "../common/window_wait.h"
#include "../common/logging.h"
#include "../common/fps_monitor.h"
#include "../common/score_monitor.h"

using namespace autoplay;

// DirectInput scan codes.
static const BYTE DIK_DOWN = 0xD0;
static const BYTE DIK_RETURN = 0x1C;

static DWORD WINAPI AutoPlayThread(LPVOID) {
    Log("=== th10_replay_autoplay: AutoPlayThread started ===");

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

    Log("Buffering 6000ms for title screen logo animation...");
    Sleep(6000);

    Log("Step 0: Enter (dismiss 'Press Any Button' title screen)");
    PressKey(DIK_RETURN);
    Sleep(1000);

    Log("Step 1: Down x2 (select 'Replay' on main menu, skipping locked 'Extra Start')");
    for (int i = 0; i < 2; i++) {
        PressKey(DIK_DOWN);
        Sleep(500);
    }

    Log("Step 2: Enter (confirm 'Replay', enter replay list)");
    PressKey(DIK_RETURN);
    Sleep(500);

    Log("Step 3: Enter (select 1st replay file)");
    PressKey(DIK_RETURN);
    Sleep(700);

    Log("Step 4: Enter (confirm playback, start replay from Stage 1)");
    PressKey(DIK_RETURN);
    Sleep(700);

    Log("=== th10_replay_autoplay: sequence complete ===");
    return 0;
}

BOOL WINAPI DllMain(HINSTANCE hinst, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(hinst);
        LogInit(hinst, "th10_autoplay.log");
        Log("DLL_PROCESS_ATTACH: installing IAT hook");
        InstallDinputHook();
        // リプレイずれ判定用のスコア等サンプリング(Issue #103)。RVAはthprac
        // (thprac_th10.cpp)の`enum ADDRS`および`THGuiPrac::State()`内の実書き込み
        // コードから収集した絶対VA(0x474c44=score, 0x474c70=life, 0x474c7c=stage)を、
        // 0x474c00を基点(RVA=0x74c00)としたオフセットに整理したもの。score(内部値)は
        // 画面表示値の1/10(th07/th08/th11/th20と同じ×10系列)。グレイズはth10エンジン
        // にそもそも実装が見当たらない(thprac側もTHPracParamにgrazeフィールドが無い)
        // ため計測しない。フル尺録画での記録スコアとの完全一致を実機確認済み
        // (touhou-recorder reports/57、150,277,360で一致)。
        {
            ScoreMonitorConfig sm;
            sm.baseRva = 0x74c00;
            sm.baseIsPointer = false;
            sm.scoreOffset = 0x44;
            sm.scoreWidth = 4;
            sm.stageOffset = 0x7c;
            sm.stageWidth = 4;
            sm.livesOffset = 0x70;
            sm.livesWidth = 4;
            sm.intervalMs = 1000;
            StartScoreMonitorThread(sm);
        }
        StartFpsMonitorThread();
        CreateThread(NULL, 0, AutoPlayThread, NULL, 0, NULL);
    }
    return TRUE;
}
