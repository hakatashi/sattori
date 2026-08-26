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
#include "../common/dinput_hook.h"
#include "../common/window_wait.h"
#include "../common/logging.h"
#include "../common/score_monitor.h"

using namespace autoplay;

// DirectInput scan codes.
static const BYTE DIK_DOWN = 0xD0;
static const BYTE DIK_RETURN = 0x1C;

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
    Sleep(1500);

    Log("Step 1: Down x2 (select 'Replay' on main menu)");
    for (int i = 0; i < 2; i++) {
        PressKey(DIK_DOWN);
        Sleep(250);
    }

    Log("Step 2: Enter (confirm 'Replay', enter replay list)");
    PressKey(DIK_RETURN);
    Sleep(700);

    Log("Step 3: Enter (select 1st replay file)");
    PressKey(DIK_RETURN);
    Sleep(700);

    Log("Step 4: Enter (select default start stage)");
    PressKey(DIK_RETURN);
    Sleep(700);

    Log("Step 5: Enter (select normal playback mode, start replay)");
    PressKey(DIK_RETURN);
    Sleep(700);

    Log("=== th07_replay_autoplay: sequence complete ===");
    return 0;
}

BOOL WINAPI DllMain(HINSTANCE hinst, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(hinst);
        LogInit(hinst, "th07_autoplay.log");
        Log("DLL_PROCESS_ATTACH: installing IAT hook");
        InstallDinputHook();
        // リプレイずれ判定用のスコア等サンプリング(Issue #103)。
        //
        // Sattoriが配布しているth07.exe(ver 1.00b、650752バイト)は
        // touhou-recorderがフェーズ53で検証に使ったth07.exe(ver 1.00、
        // 607744バイト、公式パッチ適用前)とバイナリが異なり、当初
        // フェーズ53のRVA(`0x21c250`、旧バイナリ向けの補正値)では
        // `GAME_MANAGER->globals`が常に0のままでスコアが一切取得できなかった
        // (Issue #168)。
        //
        // touhou-recorderのフェーズ54で、ver1.00bのゲームデータ
        // (`games/th07_ver100b/`、Sattoriと同一バイナリ)を使って再調査した
        // 結果、**ver1.00bについてはthprac記載のGAME_MANAGER絶対VA
        // `0x626270`(RVA `0x226270`)がそのまま正しい**ことが判明した
        // (ステージ番号RVAの実測値`0x22f85c`が、`0x226270 + 0x95ec`という
        // thprac側のオフセットからの予測値と1バイトの狂いもなく一致した
        // ことで裏付け済み)。フェーズ53で「thprac記載の値は誤り」としていた
        // のは、検証に使った旧バイナリがthpracの対象(ver1.00b)と単に違って
        // いただけだった。true_score(int32, globals+0x4)は画面表示値の1/10
        // (th11/th20と同じ慣習)。life_countはfloat(破片管理のため)。
        // フル尺録画でリプレイ記録スコアとの完全一致を実機確認済み
        // (touhou-recorder
        // reports/54_phase54_th07_ver100b_reverification.md)。
        {
            ScoreMonitorConfig sm;
            sm.baseRva = 0x226270 + 0x8; // GAME_MANAGER(thprac記載のまま)->globals フィールド
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
        CreateThread(NULL, 0, AutoPlayThread, NULL, 0, NULL);
    }
    return TRUE;
}
