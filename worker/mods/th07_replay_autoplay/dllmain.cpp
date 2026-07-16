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

    Log("Step 1: Down x3 (select 'Replay' on main menu)");
    for (int i = 0; i < 3; i++) {
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
        CreateThread(NULL, 0, AutoPlayThread, NULL, 0, NULL);
    }
    return TRUE;
}
