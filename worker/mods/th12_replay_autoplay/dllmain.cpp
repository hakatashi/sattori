// th12(東方星蓮船 / Undefined Fantastic Object)の自動再生MOD。
//
// メインメニュー -> Replay -> (ユーザーリプレイタブへ切替) -> (1番目選択) -> (再生確定)
// を自動操作する。**th12は既存2タイトルのどちらとも完全一致しないハイブリッド仕様**である
// 点に注意:
//
// - 入力注入経路はth10と同じ(DirectInput GetDeviceStateが実際に56〜60Hzでポーリング
//   される。FpsMonitorログで確認、touhou-recorder reports/61)。th11用に実装した
//   Win32 GetKeyboardStateフック(PressVKey)は使えない —— 最初にこちらで実装したところ
//   ビルド・注入・「sequence complete」ログ出力までは正常に完了したが、実際には
//   メニュー操作が一切反映されず、リプレイがタイトル画面のアトラクトデモのまま進行
//   しなかった(WaitForHookActiveはGetDeviceState/GetKeyboardStateのどちらかが
//   呼ばれていれば成立してしまうため、この誤りは起動時エラーとして検出できない)。
//   PressKey(DIKスキャンコード経由)に切り替えて解消した。
// - メニュー操作シーケンス自体はth11と同じ(Down x2 -> Enter(Replay) ->
//   Right(ユーザーリプレイタブへ切替) -> Enter(1番目選択) -> Enter(再生確定))。
//   th10にある「PRESS ANY BUTTON表示をEnterで消す」ステップはth12には無い。
//
// この2点を混同して「th10だからth10のシーケンスをそのまま使う」「th11だから
// GetKeyboardStateを使う」と早合点しないこと。

#include <windows.h>
#include "../common/dinput_hook.h"
#include "../common/window_wait.h"
#include "../common/logging.h"
#include "../common/fps_monitor.h"
#include "../common/score_monitor.h"

using namespace autoplay;

// DirectInput scan codes.
static const BYTE DIK_DOWN = 0xD0;
static const BYTE DIK_RIGHT = 0xCD;
static const BYTE DIK_RETURN = 0x1C;

static DWORD WINAPI AutoPlayThread(LPVOID) {
    Log("=== th12_replay_autoplay: AutoPlayThread started ===");

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

    Log("Step 1: Down x2 (select 'Replay' on main menu)");
    for (int i = 0; i < 2; i++) {
        PressKey(DIK_DOWN);
        Sleep(250);
    }

    Log("Step 2: Enter (confirm 'Replay', enter replay list)");
    PressKey(DIK_RETURN);
    Sleep(700);

    Log("Step 3: Right (switch to user replay tab)");
    PressKey(DIK_RIGHT);
    Sleep(500);

    // th11と同じスロット命名規約: 対象リプレイをインスタンスのreplay/配下に
    // "th12_ud0000.rpy"として配置しておく必要がある(record_th12.pyのcanonical_slot)。
    Log("Step 4: Enter (select 1st user replay file)");
    PressKey(DIK_RETURN);
    Sleep(700);

    Log("Step 5: Enter (confirm playback, start replay)");
    PressKey(DIK_RETURN);
    Sleep(700);

    Log("=== th12_replay_autoplay: sequence complete ===");
    return 0;
}

BOOL WINAPI DllMain(HINSTANCE hinst, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(hinst);
        LogInit(hinst, "th12_autoplay.log");
        Log("DLL_PROCESS_ATTACH: installing IAT hook");
        InstallDinputHook();
        // リプレイずれ判定用のスコア等サンプリング(Issue #103)。RVAはthprac
        // (thprac_th12.cppの`THAdvOptWnd`内、プラクティスモードパラメータ書き込み
        // コード)から収集した絶対VA(0x4b0c44=score)を、image base(0x400000)を
        // 引いたRVA(0xb0c44)を基点としたオフセットに整理したもの。score(内部値)は
        // 画面表示値の1/10(th07/th08/th10/th11/th20と同じ×10系列)。th10・th11と
        // 同じくポインタ間接参照は不要(固定RVAに直接値が置かれる)。フル尺録画
        // (通常・Extraステージ両方)で記録スコアとの完全一致を実機確認済み
        // (touhou-recorder reports/62)。
        {
            ScoreMonitorConfig sm;
            sm.baseRva = 0xb0c44;
            sm.baseIsPointer = false;
            sm.scoreOffset = 0x00;
            sm.scoreWidth = 4;
            sm.stageOffset = 0x6c;
            sm.stageWidth = 4;
            sm.livesOffset = 0x54;
            sm.livesWidth = 4;
            sm.grazeOffset = 0x98;
            sm.grazeWidth = 4;
            sm.intervalMs = 1000;
            StartScoreMonitorThread(sm);
        }
        StartFpsMonitorThread();
        CreateThread(NULL, 0, AutoPlayThread, NULL, 0, NULL);
    }
    return TRUE;
}
