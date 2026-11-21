// th15 (東方紺珠伝 ～ Legacy of Lunatic Kingdom.) replay auto-play MOD.
//
// Injects into th15.exe and, after the title screen finishes loading,
// automatically navigates: MainMenu -> Replay -> (user replay tab) ->
// (1st user replay file) -> (confirm playback), with no user interaction
// required.
//
// th15はth20と同じく960p相当・APPDATA配下にcfg/replayを配置するエンジンだが、
// 入力ポーリング方式はth20/th11のGetKeyboardStateではなく、th06/07/08/10と
// 同じDirectInputのGetDeviceStateだった(実機検証で判明、reports/82参照)。
// GetKeyboardState方式(PressVKey)ではメニューへの入力が反映されず、無操作
// のままアトラクトデモ(「Demo Play」表示、Normal固定)に落ちることを確認した
// 一方、PressKey(DIKコード)に切り替えると期待通りメニュー操作が反映された。
//
// Menu sequence (per user-supplied spec, confirmed on real hardware): title
// screen shows ~1-10s of logo animation before input is accepted, then
// Down x2 -> Enter selects "Replay" from the main menu (Extra Startが未解放の
// 新規セーブデータではカーソルがスキップするため、Game Start -> Practice ->
// Replay の順でDown x2に短縮される) -> immediately transitions to the replay
// selection screen -> Right switches to the user replay tab -> Enter selects
// the 1st user replay file -> Enter confirms playback.

#include <windows.h>
#include <stdlib.h>
#include "../common/dinput_hook.h"
#include "../common/window_wait.h"
#include "../common/logging.h"
#include "../common/fps_monitor.h"
#include "../common/fps_limiter_hook.h"
#include "../common/d3d9_probe_hook.h"
#include "../common/dsound_hook.h"
#include "../common/fps_display_hook.h"
#include "../common/stage_probe_hook.h"
#include "../common/stage_marker_io.h"
#include "../common/score_monitor.h"
#include "../common/timer_probe_hook.h"
#include "../common/speed_hack_hook.h"
#include "../common/d3dx_filter_hook.h"
#include "../common/frame_sync_hook.h"
#include "../common/dsound_probe_hook.h"

using namespace autoplay;

// DirectInput DIKコード(th06/07/08/10と同じGetDeviceState方式)。
static const BYTE DIK_DOWN = 0xD0;
static const BYTE DIK_RIGHT = 0xCD;
static const BYTE DIK_RETURN = 0x1C;

// th20と同じくレンダリングfpsとゲーム内ロジック更新が直結している想定のため、
// FPS_LIMIT_TARGET_HZでPresentを間引く場合はメニュー操作待機も同じ比率で
// 延長する(mods/th20_replay_autoplay/dllmain.cppと同じ仕組み)。
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
    Log("=== th15_replay_autoplay: AutoPlayThread started ===");

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

    // ユーザー仕様: タイトル画面表示後1秒程度でキー入力可能になるはずだが、
    // MODによってロード中画面がタイトル画面として誤認識される可能性がある
    // ため、最大10秒程度までウェイトを延長する(th20のロゴアニメーション
    // 待機と同じ考え方、reports/44参照)。
    DWORD titleWaitMs = FrameSyncActive() ? 11500 : 10000;
    Log("Buffering %lums (scaled) for title screen load...", (unsigned long)titleWaitMs);
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

    // ステージロード検出は、ゲーム起動時の巨大なアセット読み込みを拾わない
    // よう、リプレイ再生を始める直前まで無効にしておく(th20と同じ方式)。
    ArmStageMarkerIo();

    Log("Step 4: Enter (select 1st user replay file)");
    PressKey(DIK_RETURN);
    ScaledSleep(700);

    Log("Step 5: Enter (confirm playback, start replay)");
    PressKey(DIK_RETURN);
    ScaledSleep(700);

    // フレーム同期キャプチャ(reports/105): ここまでのメニュー操作は実時間60Hzで行い、
    // リプレイ再生に入ってから上限を外す(FRAME_SYNC_PIPE未設定なら何もしない)。
    FrameSyncSetUnthrottled(true);

    Log("=== th15_replay_autoplay: sequence complete ===");
    return 0;
}

BOOL WINAPI DllMain(HINSTANCE hinst, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(hinst);
        LogInit(hinst, "th15_autoplay.log");
        Log("DLL_PROCESS_ATTACH: installing IAT hooks");
        InstallDinputHook();
        // D3DXLoadSurfaceFromMemoryの縮小フィルタ補完(文字のジャギー対策、reports/101)。
        // D3DX_AREA_FILTER/D3DX_LOAD_PROBE未設定なら何もしない。
        InstallD3DXFilterHook();
        InstallKeyboardStateHook();
        // 倍速録画検証(issue #1)。th15はメインループ内でQueryPerformanceCounterを
        // ビジーポーリングしてフレームレートを制御しており(TIMER_PROBE=1調査で判明、
        // reports/85)、Present間引き方式のInstallFpsLimiterHookだけでは上限しか
        // 制御できず倍速化されない。QPCの経過時間そのものを引き伸ばして錯覚させる。
        InstallSpeedHackHook();
        // フレーム同期キャプチャ(reports/105)。FRAME_SYNC_PIPE設定時だけ有効で、タイマーと
        // Sleepを仮想時計に差し替える。倍速・低速録画(SPEED_HACK_MULTIPLIER、
        // FPS_LIMIT_TARGET_HZ)とは併用しない。InstallFpsLimiterHookより前に呼ぶ。
        InstallFrameSyncHook();
        // AWS実機でのフレームペーシング崩れ対策(th20と同じ、reports/46参照)。
        // 診断用の描画記録(D3D9_PROBE=1のときだけ有効、reports/99)。CreateDeviceより前に登録する。
        InstallD3D9ProbeHook();
        InstallFpsLimiterHook(60.0);
        InstallDSoundHook(1.0);
        // DirectSoundの使い方の記録(DSOUND_PROBE=1のときだけ有効、reports/106)。
        InstallDSoundProbeHook();
        // 低速録画でfps表示が低いままになる問題の補正(reports/93)。FPSInfの更新(0x335f0)が
        // 時刻取得関数(0x72c90)を呼ぶ経路だけを偽装する。0x72c90はフレームペーシング等と
        // 共有なのでQPCの戻り先だけでは絞り込めない。倍速録画では倍率1.0となり無効。
        // InstallSpeedHackHookより後に呼ぶこと(return addressで呼び出し元を判定するため)。
        InstallFpsDisplayCorrectionHookViaCaller(0x00072ccb, 0x00033600);
        // ステージ開始検出手段の調査用(STAGE_PROBE=1のときのみ有効)。
        InstallStageProbeHook();
        // 倍速録画検証用の診断(TIMER_PROBE=1のときのみ有効、issue #1)。
        InstallTimerProbeHook();
        // th15もth20と同様にステージ番号変数が未特定の可能性が高いため、
        // th15.datのアセットロードバーストでステージ開始を検出する方式を
        // 暫定採用する(STAGE_PROBEでの実機確認が必要)。
        InstallStageMarkerIoHook("th15.dat", /*burstBytes=*/1024 * 1024);
        // リプレイずれ(デシンク)判定用のスコア等のサンプリング。RVAは
        // thprac(thprac_th15.cpp)のth15_patch_mainフック内で確認した絶対
        // アドレス(th15.exeのImageBase=0x400000)由来: score=0x4E740C
        // (内部値、表示は×10)・life=0x4E7450・graze=0x4E741C。いずれも
        // ポインタ経由ではなくモジュール直下の静的領域に直接配置されている
        // (th20のGlobalsSide構造体のようなポインタ間接参照は不要)。
        // ステージ番号を保持する単純な変数は見つからなかった(CalcSection()
        // による複雑な区間判定のみ)ため、stageWidth=0のまま無効にしておく。
        {
            ScoreMonitorConfig sm;
            sm.baseRva = 0xE7400; // = 0x4E7400 - 0x400000
            sm.baseIsPointer = false;
            sm.scoreOffset = 0x0C; // = 0x4E740C - 0x4E7400
            sm.scoreWidth = 4;
            sm.stageOffset = 0;
            sm.stageWidth = 0;
            sm.livesOffset = 0x50; // = 0x4E7450 - 0x4E7400
            sm.livesWidth = 4;
            sm.grazeOffset = 0x1C; // = 0x4E741C - 0x4E7400
            sm.grazeWidth = 4;
            sm.intervalMs = 1000;
            StartScoreMonitorThread(sm);
        }
        StartFpsMonitorThread();
        CreateThread(NULL, 0, AutoPlayThread, NULL, 0, NULL);
    }
    return TRUE;
}
