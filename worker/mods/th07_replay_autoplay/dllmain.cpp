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
        // リプレイずれ判定用のスコア等サンプリング(Issue #103)は、th07では
        // **現時点で無効化してある**(未着手ではなく、実機検証の結果あえて無効に
        // している——理由は下記)。
        //
        // touhou-recorder側(reports/53_phase53_score_monitor_all_titles.md)で
        // 実機検証済みのRVAは、th07 GAME_MANAGER構造体の絶対VA
        // (thprac_th07.cppの`0x626270`をstageマーカーの実測RVA 0x0022583cから
        // 補正した`0x0021c250`)に基づく。Sattori側でこのMOD(score_monitor.cpp
        // 移植・実機動作確認)を行った際、**Sattoriが実際に配布しているth07.exeは
        // touhou-recorderが検証に使ったth07.exeとバイナリが異なる**ことが判明した
        // ——版数文字列で確認するとSattori側は`ver 1.00b`(650752バイト)、
        // touhou-recorder側は`ver 1.00`(607744バイト、公式パッチ適用前)。
        // このRVAをSattoriのth07.exeにそのまま適用すると`GAME_MANAGER->globals`
        // が常に0のままでスコアが一切取得できない(実機確認済み)。
        //
        // th07以外の4タイトル(th06/th08/th11/th20)はSattoriのゲームバイナリと
        // touhou-recorderの検証環境が完全一致(th08は`ver 1.00d`同士、他は
        // MD5一致)しており、いずれも実機でScoreMonitorのスコア単調増加を確認
        // 済み。th07だけがこのバイナリ差の影響を受けている。
        //
        // th07用の正しいRVAの再特定はIssue #168で追跡する
        // (`worker/mods/common/stage_probe_hook.*`/`score_probe_hook.*`、
        // 診断専用・本番ビルドには含めない、を使う見込み)。th07のジョブは
        // `worker/recording_common.check_replay_desync()`側でMODログが
        // 得られないケースとして扱われ(検証スキップ、`desyncDetected`は
        // 常にnullのまま)、警告が出ないだけで既存の動作に影響は無い。
        CreateThread(NULL, 0, AutoPlayThread, NULL, 0, NULL);
    }
    return TRUE;
}
