// th10 (東方風神録 / Mountain of Faith / TH10) replay auto-play MOD.
//
// Injects into th10.exe and, after the title screen finishes loading,
// automatically navigates: MainMenu -> Replay -> (1st replay file) ->
// (confirm playback), with no user interaction required.
//
// th10.exeはth11/th20と異なり、DirectInputのGetDeviceStateが実際に
// 56〜60Hzでポーリングされることを実機で確認済み(FpsMonitorログ)ため、
// PressKey(DIKスキャンコード経由)で入力を注入する。
//
// タイトル画面は「10th Project Shrine Maiden」ロゴ(Now Loading相当)の後に
// "PRESS ANY BUTTON"表示が続き、Enterで消してメインメニューへ進む。実機
// 診断(runs/th10_bringup2/)で判明した重要な点:
//   - Enterを送るタイミングが早すぎる(1500msバッファ後)と、ロゴ画面の
//     途中でEnterが空振りし、後続のDown/Enterがことごとくずれて
//     Game Start経由でRank Select/Player Selectに迷い込む(diag2〜diag6で再現)。
//     4500msまでバッファを延ばすことで安定してタイトルを消せた(diag7)。
//   - Down連打の間隔が短すぎても同様にずれる。1000ms間隔で確実に機能した。
// この2点はいずれも「操作対象の演出アニメーションが終わるまで次の入力を
// 受け付けていない(が、入力自体はバッファされず捨てられる)」ことを示唆する。
// フェーズ58でユーザー指定の短縮版タイミング(ロゴ待ち6000ms、Step0後の
// 待機は5000ms→1000msへ大幅短縮、Down間隔・Step2待機も短縮)に変更し、
// 3回連続でReplay一覧到達・再生開始まで成功することを実機再確認した
// (`newtiming_verify1〜3.mp4`)。診断時とは待機の内訳が異なるが、タイトル
// ロゴの合計待ち時間(旧: 4500ms、新: 6000ms)は同程度以上を確保している
// ため安定して機能したと考えられる。
//
// メインメニューは Game Start / Extra Start / Practice Start / Replay /
// Player Data / Music Room / Option / Quit の8項目が常に表示されるが、
// Extra Startはカーソル移動時に自動スキップされる(実機確認: Down x1で
// Practice Start、Down x2でReplayにカーソルが移動することを
// runs/th10_bringup2/frames/pointC.png・pointD.pngで確認済み。ユーザー
// 提供の手順と一致)。
//
// リプレイ一覧は th06/07/08 と同じ単純な番号スロット方式で、ファイル名の
// 数字がそのままスロット番号(No.NN)になる(_udタブ切替は無い)。このMODは
// 常に「1番目のスロット(No.01)」を選ぶ固定シーケンスのため、
// 録画パイプライン側(recorder/games.py)でコピー先ファイル名を
// "th10_01.rpy"に正規化する(th10の`replay_dest_filename`参照)。

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
#include "../common/stage_marker_hook.h"
#include "../common/stage_probe_hook.h"
#include "../common/d3dx_filter_hook.h"

using namespace autoplay;

// DirectInput scan codes.
static const BYTE DIK_DOWN = 0xD0;
static const BYTE DIK_RETURN = 0x1C;

// 低速録画(フェーズ58、th20のreports/47と同じ方式)。th10.exeはd3d9.dll/
// DSOUND.dllを使う(インポートテーブルで確認済み)ため、th20と同じ
// fps_limiter_hook(Presentのvtableフック)・dsound_hook(SetFrequencyの
// vtableフック)がそのまま適用できる基盤はあるが、「Presentの間引きが
// ゲーム内ロジック更新頻度と連動するか(th20で確認された性質)」はth10では
// 未検証。メニュー操作の待機時間だけは、この性質の有無によらず安全側で
// スケールしておく(GetMenuTimeScale/ScaledSleepはth20のdllmain.cppと同一実装)。
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
    Log("=== th10_replay_autoplay: AutoPlayThread started ===");

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

    DWORD titleWaitMs = FrameSyncActive() ? 8000 : 6000;
    Log("Buffering %lums (scaled) for title screen animation...", (unsigned long)titleWaitMs);
    ScaledSleep(titleWaitMs);

    Log("Step 0: Enter (dismiss 'Press Any Button' title screen)");
    PressKey(DIK_RETURN);
    ScaledSleep(1000);

    Log("Step 1: Down x2 (select 'Replay' on main menu, skipping locked 'Extra Start')");
    for (int i = 0; i < 2; i++) {
        PressKey(DIK_DOWN);
        ScaledSleep(500);
    }

    Log("Step 2: Enter (confirm 'Replay', enter replay list)");
    PressKey(DIK_RETURN);
    ScaledSleep(500);

    Log("Step 3: Enter (select 1st replay file)");
    PressKey(DIK_RETURN);
    ScaledSleep(700);

    Log("Step 4: Enter (confirm playback, start replay from Stage 1)");
    PressKey(DIK_RETURN);
    LogReplayStartMarker();
    ScaledSleep(700);

    FrameSyncSetUnthrottled(true);

    Log("=== th10_replay_autoplay: sequence complete ===");
    return 0;
}

BOOL WINAPI DllMain(HINSTANCE hinst, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(hinst);
        LogInit(hinst, "th10_autoplay.log");
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
        // 低速録画(フェーズ58)。FPS_LIMIT_TARGET_HZ未設定時はscale=1.0で
        // 従来動作と完全互換(th20のreports/47と同じ設計)。
        InstallFpsLimiterHook(60.0);
        InstallDSoundHook(1.0);
        InstallDSoundProbeHook();
        // ステージ開始検出手段の調査用(STAGE_PROBE=1のときのみ有効、フェーズ49)。
        InstallStageProbeHook();
        // ステージ番号変数のポーリングによるステージ開始時刻検出(フェーズ49方式)。
        // RVAはthprac(thprac_th10.cpp)の`STAGE_NUM = 0x474c7c`(絶対VA)由来、
        // image base 0x400000として RVA=0x74c7c。stageBase=0(生値がそのまま
        // N面を表す。プラクティスで6面のみプレイしたリプレイ(th10_07.rpy)で
        // 終始stage=6を示すことを確認しており、これはプラクティスの開始面が
        // 6面固定であるための正しい値だった。当初「常に6固定の異常値」と
        // 誤認していたが、これはth10_07.rpyがプラクティス専用リプレイ
        // (@sattori/touhou-replay-parserのsplits.length=1、stage=6のみ)だった
        // ためであり、RVA自体は正常に機能している。フル尺録画での通しプレイ
        // 検証(th10_01/02/04/11等、splits=1..6)で1〜6面の遷移を要再確認)。
        InstallStageMarkerHook(0x74c7c, /*width=*/4, /*stageBase=*/0);
        // リプレイずれ判定用のスコア等サンプリング(フェーズ53方式をth10に適用)。
        // RVAは全てthprac(thprac_th10.cpp)の`enum ADDRS`および
        // `THGuiPrac::State()`内の実書き込みコードから収集した絶対VA
        // (0x474c44=score, 0x474c70=life, 0x474c7c=stage, 0x474c68=chara,
        // 0x474c6c=subshot)を、0x474c00を基点(RVA=0x74c00)としたオフセットに
        // 整理したもの。フル尺録画(th10_24.rpy)での記録スコアとの完全一致
        // (150,277,360)を確認済み(フェーズ57、reports/57参照)。score(内部値)
        // は表示値の1/10(th07/th11/th20と同じ×10系列)。グレイズはth10
        // エンジンにそもそも実装が見当たらない(thprac側もTHPracParamに
        // grazeフィールドが無い)ため計測しない。
        {
            ScoreMonitorConfig sm;
            sm.baseRva = 0x74c00;
            sm.baseIsPointer = false;
            sm.scoreOffset = 0x44;
            sm.scoreWidth = 4;
            sm.stageOffset = 0x7c;
            sm.stageWidth = 4;
            sm.livesOffset = 0x70;
            sm.livesWidth = 4;
            sm.intervalMs = 1000;
            StartScoreMonitorThread(sm);
        }
        StartFpsMonitorThread();
        CreateThread(NULL, 0, AutoPlayThread, NULL, 0, NULL);
    }
    return TRUE;
}
