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

    Log("=== th08_replay_autoplay: sequence complete ===");
    return 0;
}

BOOL WINAPI DllMain(HINSTANCE hinst, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(hinst);
        LogInit(hinst, "th08_autoplay.log");
        Log("DLL_PROCESS_ATTACH: installing IAT hook");
        InstallDinputHook();
        // リプレイずれ判定用のスコア等サンプリング(Issue #103)。RVAはthprac
        // (thprac_th08.cpp)の`GetMemAddr`ヘルパが辿るプレイヤー状態構造体への
        // ポインタ変数(絶対VA 0x160f510、RVA=0x120f510)由来。1段階のポインタ間接
        // 参照が必要。score/graze(いずれもint32)は画面表示値の1/10(th07/th11/th20
        // と同じ慣習。導入当初は「th06と同じく等倍」と予想していたが誤りだった)。
        // life(float、破片管理)。フル尺録画でリプレイ記録スコアとの完全一致を
        // 実機確認済み(touhou-recorder
        // reports/53_phase53_score_monitor_all_titles.md)。
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
