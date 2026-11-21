// th09 (東方花映塚 / Phantasmagoria of Flower View, TH09) replay auto-play MOD.
//
// Injects into th09.exe and, after the title screen finishes loading,
// automatically navigates: MainMenu -> Replay -> (switch to user-replay tab)
// -> (1st replay file) -> (confirm playback), with no user interaction
// required.
//
// th09はth06/07/08と同じ世代のエンジンで、DirectInputのGetDeviceStateが
// 実ポーリング経路であることを実機確認済み(touhou-recorder reports/68の
// FpsMonitorログで起動直後から100Hz超のGetDeviceState呼び出しを確認、th12の
// 教訓通りGetKeyboardState方式ではないことを確かめてからPressKeyに決めた)。
//
// メニュー操作シーケンス(ユーザー提供、touhou-recorder reports/68):
//   Down x2 -> Enter(「Replay」選択、直ちにリプレイ選択画面へ遷移)
//   -> Right x1(ユーザーリプレイタブへ切替) -> Enter(1番目のリプレイ選択)
//   -> Enter(再生確定)
// th11/th12/th20と同じ「ud0000タブ」方式のため、record_th09.py側で
// コピー先ファイル名を常に"th9_ud0000.rpy"に正規化する(GameConfig.canonical_slot)。
// 実行ファイル名はth09.exeだが、リプレイファイル名の接頭辞は"th9_"
// (th09ではなくth9)である点に注意(実機検証で判明)。

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
#include "present/capture/d3d8_readback.h"
#include "present/capture/frame_sync.h"
#include "present/limiter.h"

using namespace autoplay;

// DirectInput scan codes.
static const BYTE DIK_DOWN = 0xD0;
static const BYTE DIK_RIGHT = 0xCD;
static const BYTE DIK_RETURN = 0x1C;

static DWORD WINAPI AutoPlayThread(LPVOID) {
    Log("=== th09_replay_autoplay: AutoPlayThread started ===");

    DWORD pid = GetCurrentProcessId();
    // 起動待ちの上限は低速録画でだけ伸ばす(core/time_scale.h の StartupTimeout)。
    // 低速録画時はD3D8のPresent間引き(present/limiter、Sleep+ビジーウェイト)がCPUを占有し、
    // タイトル画面ロード完了までの実時間が通常より延びることを実機確認した(30fps設定で
    // ホスト高負荷時に30秒を超えることがあった、touhou-recorder reports/68)。
    // 倍速録画では縮めない: ゲームの起動・ウィンドウ生成は実時間で進むため、2倍速で15秒に
    // 縮めたところ本番E2Eで起動待ちがタイムアウトした(Issue #288)。Issue #393 でこの扱いを
    // 全タイトルの起動待ちに広げた。
    const DWORD startupTimeoutMs = time_scale::StartupTimeout(30000);
    HWND hwnd = WaitForStableWindow(pid, /*stableMs=*/800, /*timeoutMs=*/startupTimeoutMs);
    if (!hwnd) {
        Log("ERROR: game window never appeared, aborting sequence");
        return 1;
    }

    if (!WaitForHookActive(/*timeoutMs=*/startupTimeoutMs)) {
        Log("ERROR: GetDeviceState hook was never called, aborting sequence");
        return 1;
    }

    Log("Buffering 1500ms (scaled) for title screen animation...");
    time_scale::MenuSleep(1500);

    LogStep(1, "Down x2 (select 'Replay' on main menu)");
    for (int i = 0; i < 2; i++) {
        PressKey(DIK_DOWN);
        time_scale::MenuSleep(250);
    }

    LogStep(2, "Enter (confirm 'Replay', enter replay list)");
    PressKey(DIK_RETURN);
    time_scale::MenuSleep(700);

    LogStep(3, "Right (switch to user-replay tab)");
    PressKey(DIK_RIGHT);
    time_scale::MenuSleep(400);

    LogStep(4, "Enter (select 1st replay file)");
    PressKey(DIK_RETURN);
    time_scale::MenuSleep(700);

    LogStep(5, "Enter (confirm playback, start replay)");
    PressKey(DIK_RETURN);
    time_scale::MenuSleep(700);

    frame_sync::SetUnthrottled(true);
    LogSequenceComplete("th09");
    return 0;
}

BOOL WINAPI DllMain(HINSTANCE hinst, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(hinst);
        LogInit(hinst, "th09_autoplay.log");
        InitRuntimeConfig();
        Log("DLL_PROCESS_ATTACH: installing IAT hook");
        InstallDinputHook();
        if (!InstallFrameSyncD3D8(32)) {
            // 倍速録画(reports/89): SPEED_HACK_MULTIPLIER未設定(等倍)なら何もしない。
            InstallSpeedHackHook();
            // Presentの上限(present/limiter)。th09はDirect3D8エンジンのため、D3D8のアダプタを使う。
            // **ユーザー向けにはth09の低速録画は未サポート**(recordingPlan.tsのth09の段に低速録画の
            // 段が無い)。倍速録画ではPresentの上限を60×倍率へ引き上げる。FPS_LIMIT_TARGET_HZ未設定時は
            // 60fpsの上限。
            InstallFpsLimiterHookD3D8();
            // 低速録画時の画面上fpsカウンター表示補正(touhou-recorder reports/69)。
            // th09はtouhou-recorder の `mods/common/timer_probe_hook.*`による調査の結果、th20と異なり
            // QueryPerformanceCounterではなくWINMM.dll!timeGetTime(rva=0x00031701、
            // Present呼び出し頻度と1:1で相関する唯一の持続的なtimeGetTime呼び出し元)が
            // fps表示計算に使われていることが判明した。FPS_LIMIT_TARGET_HZ未設定時は
            // scale=1.0で実質無効化。
            InstallFpsDisplayCorrectionHookTimeGetTime(0x00031701);
        }
        InstallDSoundHook();
        // P1残機の監視(Issue #103の枠組み、touhou-recorder reports/68)。
        // thprac(thprac_th09.cpp)のTH09Toolsから収集したRVA(絶対VA 0x4a7d94、
        // image base 0x400000)を基点(RVA=0xa7d94)としたポインタ間接参照で、
        // +0xa8がlife(0.5刻みの残機を2倍した整数、1〜10)。
        //
        // スコアはthprac_th09.cppにスコア表示/編集UIが無く既知のRVAが得られず、
        // 実機でのメモリ全域スキャン(プレイヤー構造体・弾幕マネージャ構造体・
        // BSS領域をint32/int64/floatで解釈)でも表示スコアと一致するアドレスを
        // 発見できなかった(touhou-recorder reports/68)。scoreWidth=0を指定し
        // スコア読み取り自体をスキップする(score_monitor.h参照)。P2側は
        // ScoreMonitorConfigが単一のstage/lives/graze欄しか持たない構造上、
        // 今回は自分側(P1)のみ監視する。
        {
            ScoreMonitorConfig sm;
            sm.baseRva = 0xa7d94;
            sm.baseIsPointer = true;
            sm.scoreWidth = 0;
            sm.livesOffset = 0xa8;
            sm.livesWidth = 4;
            sm.intervalMs = 1000;
            StartScoreMonitorThread(sm);
        }
        CreateThread(NULL, 0, AutoPlayThread, NULL, 0, NULL);
    }
    return TRUE;
}
