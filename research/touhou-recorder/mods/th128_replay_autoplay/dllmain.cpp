// th128 (妖精大戦争 ～ 東方三月精 / Fairy Wars / TH128) replay auto-play MOD.
//
// Injects into th128.exe and, after the title screen finishes loading,
// automatically navigates: MainMenu -> Replay -> (user replay tab) ->
// (1st user replay file) -> (confirm playback), with no user interaction
// required.
//
// Per user instruction the menu operation sequence is: Down x1 ->
// Enter(Replay) -> Right(switch to user replay tab) -> Enter(select 1st
// user replay file) -> Enter(confirm playback). th128 is built on the
// TH10 engine (thprac's thprac_th128.cpp explicitly reuses th10's tracker
// callbacks `th10_tracker_count_bomb`/`th10_tracker_count_miss`), and like
// th10/th12 (also TH10-generation engines, confirmed real-machine polling
// via GetDeviceState rather than GetKeyboardState) th128.exe imports
// DINPUT8.dll/DSOUND.dll/d3d9.dll, so we use PressKey (DIK scancode
// injection via the GetDeviceState hook) as the primary input path,
// mirroring mods/th10_replay_autoplay and mods/th12_replay_autoplay.
// InstallKeyboardStateHook() is also installed defensively (as in th10/th12)
// in case real-machine verification finds otherwise.

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
#include "../common/score_monitor.h"
#include "../common/d3dx_filter_hook.h"

using namespace autoplay;

// DirectInput scan codes.
static const BYTE DIK_DOWN = 0xD0;
static const BYTE DIK_RIGHT = 0xCD;
static const BYTE DIK_RETURN = 0x1C;

// 低速録画対応(th10・th12・th20と同じ方式)。th128.exeはd3d9.dll/DSOUND.dllを
// 使う(インポートテーブルで確認済み)ため、fps_limiter_hook(Presentの
// vtableフック)・dsound_hook(SetFrequencyのvtableフック)がそのまま適用できる
// 想定(実機検証は別フェーズで実施)。
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
    Log("=== th128_replay_autoplay: AutoPlayThread started ===");

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

    // ユーザー提供の手順: タイトル画面表示後1.5秒ほどでキー入力可能になるはずだが、
    // MODによってロード中画面がタイトル画面として誤認識される可能性があるため、
    // 最大10秒程度までウェイトを挟む。他タイトル(th10: 6000ms)より長めに取る。
    Log("Buffering 8000ms (scaled) for title screen load...");
    ScaledSleep(8000);

    Log("Step 1: Down x1 (select 'Replay' on main menu)");
    PressKey(DIK_DOWN);
    ScaledSleep(500);

    Log("Step 2: Enter (confirm 'Replay', enter replay list)");
    PressKey(DIK_RETURN);
    ScaledSleep(700);

    Log("Step 3: Right (switch to user replay tab)");
    PressKey(DIK_RIGHT);
    ScaledSleep(500);

    // th11/th12/th20と同じ規約: 対象リプレイは事前にインスタンスの
    // replay/ディレクトリへ"th128_ud0000.rpy"として配置されている必要がある。
    Log("Step 4: Enter (select 1st user replay file)");
    PressKey(DIK_RETURN);
    ScaledSleep(700);

    Log("Step 5: Enter (confirm playback, start replay)");
    PressKey(DIK_RETURN);
    ScaledSleep(700);

    FrameSyncSetUnthrottled(true);

    Log("=== th128_replay_autoplay: sequence complete ===");
    return 0;
}

BOOL WINAPI DllMain(HINSTANCE hinst, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(hinst);
        LogInit(hinst, "th128_autoplay.log");
        Log("DLL_PROCESS_ATTACH: installing IAT hooks");
        InstallDinputHook();
        // D3DXLoadSurfaceFromMemoryの縮小フィルタ補完(文字のジャギー対策、reports/101)。
        // D3DX_AREA_FILTER/D3DX_LOAD_PROBE未設定なら何もしない。
        InstallD3DXFilterHook();
        // 倍速録画(reports/89): SPEED_HACK_MULTIPLIER未設定(等倍・低速)なら何もしない。
        InstallSpeedHackHook();
        // フレーム同期キャプチャ(reports/110)。InstallFpsLimiterHookより前に呼ぶ。
        InstallFrameSyncHook();
        InstallKeyboardStateHook();
        // 低速録画用フック(実機検証は別フェーズ)。FPS_LIMIT_TARGET_HZ未設定時は
        // scale=1.0で従来動作と完全互換。
        InstallFpsLimiterHook(60.0);
        InstallDSoundHook(1.0);
        InstallDSoundProbeHook();
        // リプレイずれ判定用のスコア等サンプリング。RVAはthprac
        // (thprac_th128.cpp)の`th128_patch_main`フック(2242〜2247行目付近)内で
        // 練習モードの初期値をゲーム内変数へ直接書き込んでいる箇所の絶対VA
        // (image base 0x400000)から収集し、基点0x4b4c00(RVA=0xb4c00)からの
        // オフセットに整理したもの:
        //   score:         0x4b4cc4 (offset +0xc4, 表示値の1/10と推定・要実機検証)
        //   motivation:    0x4b4d64 (offset +0x164, 「やる気」ゲージ、0-100000)
        //   perfect_freeze:0x4b4d70 (offset +0x170, ボム相当「パーフェクトフリーズ」、0-30000)
        //   ice_power:     0x4b4d6c (offset +0x16c, 0-10000)
        //   ice_area:      0x4b4d60 (offset +0x160, float、こおらせた面積 0-3000)
        // これらは練習モード開始時にゲーム内変数へ直接書き込まれる初期値であり、
        // 実際のプレイ中も同じアドレスが更新され続けるという他タイトル
        // (th10/th12)と同じ前提に基づく(未検証、フル尺録画でリプレイ記録
        // スコアとの一致を確認するまでは暫定値として扱うこと)。
        // stage/route(0x4b4d44、th128_prac_menu_enter_2フックが書き込む
        // ルート×ステージの線形インデックス0-15)は練習モード開始時の
        // 「開始地点」設定用であり、通常プレイ中に現在位置を追従して更新される
        // 保証がないため、score_monitorには含めない(要別途検証)。
        // グレイズはth128エンジンに実装が見当たらない(thprac側もTHPracParamに
        // grazeフィールドが無い)ため計測しない。
        {
            ScoreMonitorConfig sm;
            sm.baseRva = 0xb4c00;
            sm.baseIsPointer = false;
            sm.scoreOffset = 0xc4;
            sm.scoreWidth = 4;
            sm.livesOffset = 0x164;
            sm.livesWidth = 4;
            sm.intervalMs = 1000;
            StartScoreMonitorThread(sm);
        }
        StartFpsMonitorThread();
        CreateThread(NULL, 0, AutoPlayThread, NULL, 0, NULL);
    }
    return TRUE;
}
