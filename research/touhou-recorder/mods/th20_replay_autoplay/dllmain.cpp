// th20 (東方錦上京 / Fossilized Wonders, TH20) replay auto-play MOD.
//
// Injects into th20.exe and, after the title screen finishes loading,
// automatically navigates: MainMenu -> Replay -> (user replay tab) ->
// (1st user replay file) -> (confirm playback), with no user interaction
// required.
//
// Structurally identical to mods/th11_replay_autoplay/dllmain.cpp. th20's
// import table shows both DINPUT8.dll (DirectInput8Create) and
// USER32.dll!GetKeyboardState, matching th11's TH10+ engine pattern where
// real per-frame input polling goes through GetKeyboardState rather than
// DirectInput's GetDeviceState. This MOD therefore reuses PressVKey (the
// GetKeyboardState-based injection helper) instead of PressKey/DIK codes.
//
// Menu sequence (per user-supplied spec, confirmed distinct from th11 which
// only needs Down x2 before Replay): title screen shows ~3s of logo
// animation, then Down x3 -> Enter selects "Replay" from the main menu ->
// Right switches from the built-in numbered-slot tab to the user replay
// tab -> Enter selects the 1st user replay file -> Enter confirms playback
// and starts from Stage 1.
//
// As with th11, the user replay tab assigns list slots from the numeric
// suffix in the filename (th20_ud0000.rpy -> slot "No.0000"), so the caller
// must place the target replay as "th20_ud0000.rpy" for this Enter to land
// on it.

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
#include "../common/d3d9_probe_hook.h"
#include "../common/dsound_hook.h"
#include "../common/fps_display_hook.h"
#include "../common/stage_probe_hook.h"
#include "../common/stage_marker_hook.h"
#include "../common/stage_marker_io.h"
#include "../common/score_monitor.h"

using namespace autoplay;

// Win32 virtual-key codes.
static const BYTE VK_DOWN_KEY = 0x28;
static const BYTE VK_RIGHT_KEY = 0x27;
static const BYTE VK_RETURN_KEY = 0x0D;

// th20はレンダリングfpsとゲーム内ロジック更新が直結しており(fps_limiter_hook.h参照)、
// FPS_LIMIT_TARGET_HZでPresentを間引くとメニューのロゴアニメーション・カーソル移動
// アニメーション等のフレームベース処理も同じ比率で実時間換算が伸びる。以下の
// Sleep()呼び出しは全て「60fps基準で必要な実時間」のハードコード値のため、
// 目標fpsが60未満の場合はその比率分だけ延長しないとアニメーション完了前に次の
// キー入力を送ってしまい操作が空振りする(スローモーション化PoCで実際に発生)。
static double GetMenuTimeScale() {
    // 描画性能のベンチマーク(scripts/99_bench.sh)では倍速の目標Hzに描画が届かず、
    // FPS_LIMIT_TARGET_HZ由来の待ちでは短すぎてメニュー操作が空振りする。明示的に上書きする。
    if (const char* m = getenv("MOD_MENU_TIME_SCALE")) {
        double v = atof(m);
        if (v > 0.0) return v;
    }
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
    Log("=== th20_replay_autoplay: AutoPlayThread started ===");

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

    // 実機検証(reports/44参照)で、th20のタイトルロゴアニメーションから
    // メニュー項目(Game Start等のテキスト)が実際に操作可能になるまでは
    // 従来タイトル(th11等)より大幅に長く、5000ms程度の待機ではメニューが
    // まだ表示されておらず最初の数回のDown入力が空振りすることを確認した。
    // 10000ms待つことで確実にメニュー表示後からDown x3を開始できる。
    Log("Buffering 10000ms (scaled) for title screen logo animation...");
    ScaledSleep(10000);

    Log("Step 1: Down x3 (select 'Replay' on main menu)");
    for (int i = 0; i < 3; i++) {
        PressVKey(VK_DOWN_KEY);
        ScaledSleep(250);
    }

    Log("Step 2: Enter (confirm 'Replay', enter replay list)");
    PressVKey(VK_RETURN_KEY);
    ScaledSleep(700);

    Log("Step 3: Right (switch to user replay tab)");
    PressVKey(VK_RIGHT_KEY);
    ScaledSleep(500);

    // ステージロード検出は、ゲーム起動時の巨大なアセット読み込み(実測20MB)を
    // 拾わないよう、リプレイ再生を始める直前まで無効にしておく(フェーズ49)。
    ArmStageMarkerIo();

    Log("Step 4: Enter (select 1st user replay file)");
    PressVKey(VK_RETURN_KEY);
    ScaledSleep(700);

    Log("Step 5: Enter (confirm playback, start replay from Stage 1)");
    PressVKey(VK_RETURN_KEY);
    // 1面の開始時刻の記録(フェーズ49、stage_marker_hook.h参照)
    LogReplayStartMarker();
    ScaledSleep(700);

    FrameSyncSetUnthrottled(true);

    Log("=== th20_replay_autoplay: sequence complete ===");
    return 0;
}

BOOL WINAPI DllMain(HINSTANCE hinst, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(hinst);
        LogInit(hinst, "th20_autoplay.log");
        Log("DLL_PROCESS_ATTACH: installing IAT hooks");
        InstallDinputHook();
        // 倍速録画(reports/89): SPEED_HACK_MULTIPLIER未設定(等倍・低速)なら何もしない。
        InstallSpeedHackHook();
        // フレーム同期キャプチャ(reports/110)。InstallFpsLimiterHookより前に呼ぶ。
        InstallFrameSyncHook();
        InstallKeyboardStateHook();
        // AWS実機(Intel Xeon/Nitro仮想化)でth20のフレームペーシングが崩れ、
        // ゲーム内fpsカウンターが常時75fps前後(本来60fps)になりリプレイが
        // 早回しになる不具合への対策(フェーズ46追加調査、詳細はfps_limiter_hook.h参照)。
        // 診断用の描画記録(D3D9_PROBE=1のときだけ有効、reports/99)。CreateDeviceより前に登録する。
        InstallD3D9ProbeHook();
        InstallFpsLimiterHook(60.0);
        // fps_limiter_hookによるゲーム進行のスローモーション化(reports/47)は
        // 映像・ゲームロジックのみに効き、DirectSoundのBGM/SEストリーミングには
        // 連動しないため、別途SetFrequencyフックで音声側も同じ比率でスケールする。
        InstallDSoundHook(1.0);
        InstallDSoundProbeHook();
        // th20自身のfpsカウンター表示がスローモーション化(FPS_LIMIT_TARGET_HZ)
        // に連動して低い値を表示してしまう問題(reports/47の既知の制約)への対策。
        // 表示計算に使われていることを実証済みの特定コールサイトのみ時刻の
        // 進み方を補正し、等倍相当のfps値を表示させる(reports/48参照)。
        InstallFpsDisplayCorrectionHook(0x0001cb54);
        // ステージ開始検出手段の調査用(STAGE_PROBE=1のときのみ有効、フェーズ49)
        InstallStageProbeHook();
        // th20のステージ番号変数はまだ未特定(.dataが0.2MBしかなく、TH10以降の
        // エンジンではヒープ上のゲーム管理構造体に置かれている可能性が高い)。
        // STAGE_MARKER_RVA環境変数で指定した場合のみ有効になる。
        InstallStageMarkerHook(0, /*width=*/4);
        // th20はステージ番号変数を使う方式が取れないため、th20.datのアセットロード
        // バーストでステージ開始を検出する(stage_marker_io.h参照、フェーズ49)。
        InstallStageMarkerIoHook("th20.dat", /*burstBytes=*/1024 * 1024);
        // リプレイずれ(デシンク)判定用のスコア等のサンプリング(フェーズ50)。
        // RVAはthpracのthprac_th20.cpp(rel_addrs::GAME_SIDE0 = 0x1ba568 と
        // GlobalsSide構造体)由来。GlobalsSide本体は RVA(GAME_SIDE0 + 0x88) に
        // 直に置かれており、score(uint64)がその先頭、life_stocksが+0xb8、
        // grazeが+0xe4、ステージ番号が+0x1f4。th20 ver1.00cで検証済み。
        {
            const uint32_t kGlobalsSide = 0x1ba568 + 0x88; // = 0x1ba5f0
            ScoreMonitorConfig sm;
            sm.baseRva = kGlobalsSide;
            sm.baseIsPointer = false;
            sm.scoreOffset = 0x00;
            sm.scoreWidth = 8;
            sm.stageOffset = 0x1f4;
            sm.stageWidth = 4;
            sm.livesOffset = 0xb8;
            sm.livesWidth = 4;
            sm.grazeOffset = 0xe4;
            sm.grazeWidth = 4;
            sm.intervalMs = 1000;
            StartScoreMonitorThread(sm);
        }
        StartFpsMonitorThread();
        CreateThread(NULL, 0, AutoPlayThread, NULL, 0, NULL);
    }
    return TRUE;
}
