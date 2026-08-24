// th11 (Subterranean Animism / Chireiden / TH11) replay auto-play MOD.
//
// Injects into th11.exe and, after the title screen finishes loading,
// automatically navigates: MainMenu -> Replay -> (user replay tab) ->
// (1st user replay file) -> (confirm playback), with no user interaction
// required.
//
// Structurally similar to mods/th08_replay_autoplay/dllmain.cpp, but th11
// (TH10+ engine) does NOT poll input via DirectInput GetDeviceState like
// th06/07/08 do -- CreateDevice is called (so the DirectInput hook chain
// installs successfully) but GetDeviceState is never actually invoked
// (confirmed via FpsMonitor showing 0 Hz indefinitely). Real per-frame
// input polling goes through the plain Win32 GetKeyboardState() API
// instead, so this MOD injects via that hook (PressVKey) rather than
// PressKey/DIK codes. See touhou-recorder reports/35 for the verification
// log that found this and mods/common/dinput_hook.h for the added hook.
//
// The replay list screen has two tabs: the built-in numbered slots
// (No.01-No.24, th11_01.rpy style filenames) and a separate "user replay"
// tab (th11_ud0000.rpy style filenames) reached by pressing Right once.
// This MOD targets the user replay tab, since that's where actual
// player-recorded replays belong: Down x2 -> Enter(Replay) ->
// Right(switch to user replay tab) -> Enter(select 1st user replay file)
// -> Enter(confirm playback).

#include <windows.h>
#include "../common/dinput_hook.h"
#include "../common/window_wait.h"
#include "../common/logging.h"
#include "../common/fps_monitor.h"
#include "../common/score_monitor.h"

using namespace autoplay;

// Win32 virtual-key codes.
static const BYTE VK_DOWN_KEY = 0x28;
static const BYTE VK_RIGHT_KEY = 0x27;
static const BYTE VK_RETURN_KEY = 0x0D;

static DWORD WINAPI AutoPlayThread(LPVOID) {
    Log("=== th11_replay_autoplay: AutoPlayThread started ===");

    DWORD pid = GetCurrentProcessId();
    HWND hwnd = WaitForStableWindow(pid, /*stableMs=*/800, /*timeoutMs=*/30000);
    if (!hwnd) {
        Log("ERROR: game window never appeared, aborting sequence");
        return 1;
    }

    if (!WaitForHookActive(/*timeoutMs=*/30000)) {
        Log("ERROR: neither GetDeviceState nor GetKeyboardState hook was ever called, aborting sequence");
        return 1;
    }

    // th08 only needs 1500ms here; th11's title logo animation is longer and
    // sending Down/Enter too early lands on the wrong menu item (Practice
    // Start, Rank Select, etc.) instead of "Replay". 6000ms was found to
    // reliably reach the main menu (touhou-recorder reports/35).
    Log("Buffering 6000ms for title screen animation...");
    Sleep(6000);

    Log("Step 1: Down x2 (select 'Replay' on main menu)");
    for (int i = 0; i < 2; i++) {
        PressVKey(VK_DOWN_KEY);
        Sleep(250);
    }

    Log("Step 2: Enter (confirm 'Replay', enter replay list)");
    PressVKey(VK_RETURN_KEY);
    Sleep(700);

    Log("Step 3: Right (switch to user replay tab)");
    PressVKey(VK_RIGHT_KEY);
    Sleep(500);

    // Within the user replay tab, th11 assigns each replay file to a fixed
    // list slot parsed from the number in its filename (th11_ud0001.rpy
    // always shows as slot "No.0001"), unlike th07/th08 where a single
    // copied file simply occupies slot 1. The caller MUST place the target
    // replay as "th11_ud0000.rpy" in the instance's replay/ directory for
    // this Enter to land on it (verified in touhou-recorder reports/35).
    Log("Step 4: Enter (select 1st user replay file)");
    PressVKey(VK_RETURN_KEY);
    Sleep(700);

    Log("Step 5: Enter (confirm playback, start replay)");
    PressVKey(VK_RETURN_KEY);
    Sleep(700);

    Log("=== th11_replay_autoplay: sequence complete ===");
    return 0;
}

BOOL WINAPI DllMain(HINSTANCE hinst, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(hinst);
        LogInit(hinst, "th11_autoplay.log");
        Log("DLL_PROCESS_ATTACH: installing IAT hooks");
        InstallDinputHook();
        InstallKeyboardStateHook();
        // リプレイずれ判定用のスコア等サンプリング(Issue #103)。RVAはthprac
        // (thprac_th11.cpp)の`Globals* globals = (Globals*)0x4a56e0`(絶対VA、
        // RVA=0xa56e0)由来。th20と同じくポインタ間接参照は不要(構造体自体が固定
        // RVAに置かれている)。score(int32, +0x04)は画面表示値の1/10(th07/th20と
        // 同じ慣習)。stage(+0x48)はthprac側の`STAGE_NUM`列挙値(=globals+0x48)と
        // 一致することを構造体オフセット計算で裏付け済み。フル尺録画でリプレイ
        // 記録スコアとの完全一致を実機確認済み(touhou-recorder
        // reports/53_phase53_score_monitor_all_titles.md、ゲームオーバーで終わる
        // リプレイでも最終スコアが記録値と厳密に一致することまで確認済み)。
        {
            ScoreMonitorConfig sm;
            sm.baseRva = 0xa56e0;
            sm.baseIsPointer = false;
            sm.scoreOffset = 0x04;
            sm.scoreWidth = 4;
            sm.stageOffset = 0x48;
            sm.stageWidth = 4;
            sm.livesOffset = 0x38;
            sm.livesWidth = 4;
            sm.grazeOffset = 0x74;
            sm.grazeWidth = 4;
            sm.intervalMs = 1000;
            StartScoreMonitorThread(sm);
        }
        StartFpsMonitorThread();
        CreateThread(NULL, 0, AutoPlayThread, NULL, 0, NULL);
    }
    return TRUE;
}
