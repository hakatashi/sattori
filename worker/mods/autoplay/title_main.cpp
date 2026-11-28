#include "autoplay/title_main.h"

#include <stdio.h>

#include "audio/dsound.h"
#include "autoplay/window_wait.h"
#include "clock/speed_hack.h"
#include "core/log.h"
#include "core/runtime_config.h"
#include "core/time_scale.h"
#include "input/dinput.h"
#include "monitor/score_monitor.h"
#include "present/capture/frame_sync.h"

namespace autoplay {
namespace {

// 起動待ちの上限。倍速録画でも縮めない: ゲームの起動・ウィンドウ生成は実時間で進むため、
// 2倍速で15秒に縮めたところ本番E2Eで起動待ちがタイムアウトした(Issue #288)。
// MenuSleep の倍率を掛けないこと(core/time_scale.h)。
constexpr unsigned int kStartupTimeoutMs = 30000;
constexpr unsigned int kWindowStableMs = 800;

// DirectInput scan codes.
constexpr BYTE kDikDown = 0xD0;
constexpr BYTE kDikRight = 0xCD;
constexpr BYTE kDikReturn = 0x1C;

void PressDInput(Key key) {
    switch (key) {
        case Key::kDown: PressKey(kDikDown); break;
        case Key::kRight: PressKey(kDikRight); break;
        case Key::kReturn: PressKey(kDikReturn); break;
    }
}

// Win32 virtual-key codes (VK_DOWN / VK_RIGHT / VK_RETURN).
void PressKeyboardState(Key key) {
    switch (key) {
        case Key::kDown: PressVKey(0x28); break;
        case Key::kRight: PressVKey(0x27); break;
        case Key::kReturn: PressVKey(0x0D); break;
    }
}

DWORD WINAPI AutoPlayThread(LPVOID param) {
    const TitleSpec& spec = *static_cast<const TitleSpec*>(param);
    Log("=== %s_replay_autoplay: AutoPlayThread started ===", spec.name);

    HWND hwnd = WaitForStableWindow(GetCurrentProcessId(), kWindowStableMs, kStartupTimeoutMs);
    if (!hwnd) {
        Log("ERROR: game window never appeared, aborting sequence");
        return 1;
    }

    if (!WaitForHookActive(kStartupTimeoutMs)) {
        if (spec.input == InputPath::kKeyboardState) {
            Log("ERROR: neither GetDeviceState nor GetKeyboardState hook was ever called, aborting sequence");
        } else {
            Log("ERROR: GetDeviceState hook was never called, aborting sequence");
        }
        return 1;
    }

    DWORD titleWaitMs = spec.titleWaitMs;
    if (spec.titleWaitMsFrameSync != 0 && frame_sync::Active()) titleWaitMs = spec.titleWaitMsFrameSync;
    Log("Buffering %lums (scaled) for title screen...", (unsigned long)titleWaitMs);
    time_scale::MenuSleep(titleWaitMs);

    PressFn press = spec.input == InputPath::kKeyboardState ? PressKeyboardState : PressDInput;
    return RunMenuScript(spec.name, spec.menu, spec.firstStep, press) ? 0 : 1;
}

void InstallRealtimeHooks(const TitleSpec& spec) {
    // 倍速録画(reports/89): SPEED_HACK_MULTIPLIER未設定(等倍)なら何もしない。
    InstallSpeedHackHook();
    if (spec.installLimiter) {
        const double targetHz = Config().fpsLimitTargetHz;
        if (!spec.limiterOnlyWhenScaled || (targetHz > 0.0 && targetHz != 60.0)) {
            spec.installLimiter();
        }
    }
    if (spec.realtimeExtra) spec.realtimeExtra();
}

}  // namespace

BOOL TitleDllMain(const TitleSpec& spec, HINSTANCE hinst, DWORD reason) {
    if (reason != DLL_PROCESS_ATTACH) return TRUE;

    DisableThreadLibraryCalls(hinst);
    char logName[64];
    snprintf(logName, sizeof(logName), "%s_autoplay.log", spec.name);
    LogInit(hinst, logName);
    InitRuntimeConfig();
    Log("DLL_PROCESS_ATTACH: installing IAT hooks");

    InstallDinputHook();
    if (spec.input == InputPath::kKeyboardState) InstallKeyboardStateHook();
    if (spec.textFilter) spec.textFilter();
    if (!spec.installFrameSync(spec.frameSyncStepDiv)) InstallRealtimeHooks(spec);
    // BGM/SEの再生周波数をFPS_LIMIT_TARGET_HZ/60倍にスケールし(等倍なら無変更)、
    // A/V同期マーカー(reports/88)を有効にする。
    InstallDSoundHook();
    StartScoreMonitorThread(spec.scoreMonitor);

    CreateThread(NULL, 0, AutoPlayThread, const_cast<TitleSpec*>(&spec), 0, NULL);
    return TRUE;
}

}  // namespace autoplay
