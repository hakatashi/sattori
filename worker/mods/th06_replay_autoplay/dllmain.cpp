// th06 (Embodiment of Scarlet Devil / Koumakyou / TH06) replay auto-play MOD.
//
// Injects into 東方紅魔郷.exe and, after the title screen finishes loading,
// automatically navigates: (dismiss attract-mode demo) -> MainMenu -> Replay
// -> (1st replay file) -> (start playback), with no user interaction
// required.
//
// Unlike th07/th08, th06's title screen boots directly into an attract-mode
// demo replay ("DEMO PLAY") rather than showing the main menu, so an extra
// initial Enter press is needed to dismiss it before the Down/Enter sequence
// used by the other titles' MODs. Sequence provided by the user via manual
// playthrough on real Windows:
//   title screen (~2s logo animation wait) -> Enter (show menu) ->
//   Down x2 -> Enter (select "Replay", ~2s transition wait) ->
//   Enter (select 1st replay file, ~1s wait) -> Enter (start playback)
//
// th06 additionally requires the fan-made VsyncPatch (vpatch_th06.dll) to
// avoid a wined3d white-screen hang (see reports/30_phase30_th06_rendering_fix.md);
// that DLL must be injected into the same process alongside this one (see
// mods/common/injector.cpp, which supports injecting multiple DLLs).
//
// See docs/touhou_menu_automation.md for the technical background
// (DirectInput GetDeviceState vtable hook), shared with the th07/th08 MODs.

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
    Log("=== th06_replay_autoplay: AutoPlayThread started ===");

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

    Log("Buffering 2000ms for title logo animation...");
    Sleep(2000);

    Log("Step 1: Enter (dismiss attract-mode demo, show main menu)");
    PressKey(DIK_RETURN);
    Sleep(500);

    Log("Step 2: Down x2 (select 'Replay' on main menu)");
    for (int i = 0; i < 2; i++) {
        PressKey(DIK_DOWN);
        Sleep(250);
    }

    Log("Step 3: Enter (confirm 'Replay', enter replay list)");
    PressKey(DIK_RETURN);
    Sleep(2000);

    Log("Step 4: Enter (select 1st replay file)");
    PressKey(DIK_RETURN);
    Sleep(1000);

    Log("Step 5: Enter (start replay playback)");
    PressKey(DIK_RETURN);
    Sleep(700);

    Log("=== th06_replay_autoplay: sequence complete ===");
    return 0;
}

BOOL WINAPI DllMain(HINSTANCE hinst, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(hinst);
        LogInit(hinst, "th06_autoplay.log");
        Log("DLL_PROCESS_ATTACH: installing IAT hook");
        InstallDinputHook();
        // リプレイずれ判定用のスコア等サンプリング(Issue #103)。RVAはthprac
        // (thprac_th06.cpp)の`GAME_MANAGER = (GameManager*)0x69bca0`(絶対VA、
        // ImageBase=0x400000前提、RVA=0x29bca0)由来。GameManager構造体はポインタ
        // 間接参照不要で直接この位置にある。score(uint32, +0x04)は画面表示値と
        // 等倍(th07/th11/th20と異なりth06は10倍換算不要)。livesRemaining(int8,
        // +0x181a)は1バイトのみである点に注意。フル尺録画でリプレイ記録スコアとの
        // 完全一致を実機確認済み(touhou-recorder
        // reports/53_phase53_score_monitor_all_titles.md)。
        {
            ScoreMonitorConfig sm;
            sm.baseRva = 0x29bca0;
            sm.baseIsPointer = false;
            sm.scoreOffset = 0x04;
            sm.scoreWidth = 4;
            sm.stageOffset = 0x1a34;
            sm.stageWidth = 4;
            sm.livesOffset = 0x181a;
            sm.livesWidth = 1;
            sm.grazeOffset = 0x18; // grazeInTotal(累積グレイズ)
            sm.grazeWidth = 4;
            sm.intervalMs = 1000;
            StartScoreMonitorThread(sm);
        }
        CreateThread(NULL, 0, AutoPlayThread, NULL, 0, NULL);
    }
    return TRUE;
}
