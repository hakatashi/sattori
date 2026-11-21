// th12 (Undefined Fantastic Object / Seirensen / TH12) replay auto-play MOD.
//
// Injects into th12.exe and, after the title screen finishes loading,
// automatically navigates: MainMenu -> Replay -> (user replay tab) ->
// (1st user replay file) -> (confirm playback), with no user interaction
// required.
//
// Per user instruction the menu operation sequence is identical to th11's
// (mods/th11_replay_autoplay/dllmain.cpp): Down x2 -> Enter(Replay) ->
// Right(switch to user replay tab) -> Enter(select 1st user replay file) ->
// Enter(confirm playback). HOWEVER, unlike th11 (which polls input via
// Win32 GetKeyboardState() and never actually calls DirectInput
// GetDeviceState), real-machine verification found that th12.exe DOES poll
// input via classic DirectInput GetDeviceState at a steady 57-60Hz
// (confirmed via FpsMonitor) -- same as th10, not th11. An initial
// implementation using PressVKey (the GetKeyboardState-based injection
// th11 uses) built and ran without error, logged "sequence complete", but
// had zero effect on the actual game: WaitForHookActive() succeeded
// immediately because it only checks whether GetDeviceState OR
// GetKeyboardState has been called at all, and th12 calls GetDeviceState
// on its own regardless of whether GetKeyboardState is ever invoked. The
// game was verified (screenshot at t=40s) to still be sitting on the
// title screen's idle attract-mode demo ("Demo Play" watermark) instead of
// having navigated into replay playback. Switching to PressKey (DIK
// scancode injection via the GetDeviceState hook, same mechanism as
// mods/th10_replay_autoplay/dllmain.cpp) fixed this.

#include <windows.h>
#include <stdlib.h>
#include "../common/dinput_hook.h"
#include "../common/window_wait.h"
#include "../common/logging.h"
#include "../common/speed_hack_hook.h"
#include "../common/frame_sync_hook.h"
#include "../common/dsound_probe_hook.h"
#include "../common/fps_monitor.h"
#include "../common/fps_limiter_hook.h"
#include "../common/dsound_hook.h"
#include "../common/fps_display_hook.h"
#include "../common/score_monitor.h"
#include "../common/d3dx_filter_hook.h"

using namespace autoplay;

// DirectInput scan codes.
static const BYTE DIK_DOWN = 0xD0;
static const BYTE DIK_RIGHT = 0xCD;
static const BYTE DIK_RETURN = 0x1C;

// 低速録画(フェーズ62、th10のreports/59・th20のreports/47と同じ方式)。
// th12.exeはd3d9.dll/DSOUND.dllを使う(インポートテーブルで確認済み)ため、
// th10と同じfps_limiter_hook(Presentのvtableフック)・dsound_hook
// (SetFrequencyのvtableフック)がそのまま適用できる。Extraステージのフル尺
// 録画(フェーズ62)でこのローカル開発機のCPU性能不足による処理落ち
// (重複フレーム率26.2%、FpsMonitor最小15.8Hz)が確認されたため導入した。
static double GetMenuTimeScale() {
    double targetHz = 60.0;
    const char* env = getenv("FPS_LIMIT_TARGET_HZ");
    if (env) {
        double hz = atof(env);
        if (hz > 0.0) targetHz = hz;
    }
    return 60.0 / targetHz;
}

static void ScaledSleep(DWORD baseMs) {
    if (FrameSyncActive()) {
        FrameSyncSleepMs(baseMs);
        return;
    }
    static double scale = GetMenuTimeScale();
    Sleep((DWORD)(baseMs * scale));
}

static DWORD WINAPI AutoPlayThread(LPVOID) {
    Log("=== th12_replay_autoplay: AutoPlayThread started ===");

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

    DWORD titleWaitMs = FrameSyncActive() ? 8000 : 6000;
    Log("Buffering %lums (scaled) for title screen animation...", (unsigned long)titleWaitMs);
    ScaledSleep(titleWaitMs);

    Log("Step 1: Down x2 (select 'Replay' on main menu)");
    for (int i = 0; i < 2; i++) {
        PressKey(DIK_DOWN);
        ScaledSleep(250);
    }

    Log("Step 2: Enter (confirm 'Replay', enter replay list)");
    PressKey(DIK_RETURN);
    ScaledSleep(700);

    Log("Step 3: Right (switch to user replay tab)");
    PressKey(DIK_RIGHT);
    ScaledSleep(500);

    // Same slot-numbering convention as th11: the target replay MUST be
    // placed as "th12_ud0000.rpy" in the instance's replay/ directory for
    // this Enter to land on the first user replay slot.
    Log("Step 4: Enter (select 1st user replay file)");
    PressKey(DIK_RETURN);
    ScaledSleep(700);

    Log("Step 5: Enter (confirm playback, start replay)");
    PressKey(DIK_RETURN);
    ScaledSleep(700);

    // フレーム同期キャプチャ(reports/105): メニュー操作は実時間60Hzで行い、リプレイ再生に
    // 入ってから上限を外す(FRAME_SYNC_PIPE未設定なら何もしない)。
    FrameSyncSetUnthrottled(true);

    Log("=== th12_replay_autoplay: sequence complete ===");
    return 0;
}

BOOL WINAPI DllMain(HINSTANCE hinst, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(hinst);
        LogInit(hinst, "th12_autoplay.log");
        Log("DLL_PROCESS_ATTACH: installing IAT hooks");
        InstallDinputHook();
        // D3DXLoadSurfaceFromMemoryの縮小フィルタ補完(文字のジャギー対策、reports/101)。
        // D3DX_AREA_FILTER/D3DX_LOAD_PROBE未設定なら何もしない。
        InstallD3DXFilterHook();
        // 倍速録画(reports/89): SPEED_HACK_MULTIPLIER未設定(等倍・低速)なら何もしない。
        InstallSpeedHackHook();
        // フレーム同期キャプチャ(reports/105)。FRAME_SYNC_PIPE設定時だけ有効。
        // InstallFpsLimiterHookより前に呼ぶ。
        InstallFrameSyncHook();
        InstallKeyboardStateHook();
        // 低速録画(フェーズ62)。FPS_LIMIT_TARGET_HZ未設定時はscale=1.0で
        // 従来動作と完全互換(th10・th20と同じ設計)。
        InstallFpsLimiterHook(60.0);
        InstallDSoundHook(1.0);
        // DirectSoundの使い方の記録(DSOUND_PROBE=1のときだけ有効、reports/106)。
        InstallDSoundProbeHook();
        // 画面上fpsカウンター表示の低速録画補正(フェーズ64追加調査)。
        // mods/common/timer_probe_hook.*での実測(TIMER_PROBE=1)により、
        // th12.exeのQueryPerformanceCounter呼び出し元のうちフレームごとに
        // 正確に3回呼ばれる箇所がrva=0x000508e8の1箇所のみと判明した
        // (th20のような「1回/フレームの内部自己スロットル用」と紛らわしい
        // 別候補は見つからなかった)。この1箇所のみを対象に実機検証済み
        // (reports/64参照、fps表示が「30.0fps」から「60.0fps」に変化することを
        // 目視確認)。
        InstallFpsDisplayCorrectionHook(0x000508e8);
        // リプレイずれ判定用のスコア等サンプリング。RVAはthprac
        // (thprac_th12.cpp)の`THAdvOptWnd`内の練習モードパラメータ書き込み
        // コード(1735行目付近)から収集した絶対VA(image base 0x400000)を
        // 基点0x4b0c44(score)からのオフセットに整理したもの:
        //   score: 0x4b0c44 (offset +0x00, 表示値の1/10)
        //   stage: 0x4b0cb0 (STAGE_NUM, offset +0x6c)
        //   lives: 0x4b0c98 (offset +0x54)
        //   graze: 0x4b0cdc (offset +0x98)
        // th11と同じくポインタ間接参照は不要(固定RVAに直接値が置かれる)。
        // フェーズ62のフル尺録画(通常・Extra両方)でリプレイ記録スコアとの
        // 完全一致を確認済み(reports/62参照)。
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
