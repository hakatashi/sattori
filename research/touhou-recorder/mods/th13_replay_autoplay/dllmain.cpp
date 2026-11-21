// th13 (東方神霊廟 ～ Ten Desires.、ver1.00c・非Steam版) replay auto-play MOD.
//
// th13.exeに注入し、タイトル画面のロード後に
//   Down x3 -> Enter(Replay) -> Right(ユーザーリプレイタブ) -> Enter(先頭スロット選択) -> Enter(再生)
// を自動で行う。Extraモード未解放のため「Extra Start」はスキップされ、Replayへは
// Down x3になる(ユーザー指定)。入力はDirectInputのGetDeviceStateで読まれていた
// (実機確認、reports/100)ため、th12/th15と同じくPressKey(DIKコード)で注入する。
//
// th13はcfg/replayを%APPDATA%/ShanghaiAlice/th13/から読む(recorder側のappdata_dirで配置)。
// リプレイは"th13_ud0000.rpy"に正規化して置くこと。
// 起動直後はロード中画面がタイトル画面と誤認されうるため、入力開始まで10秒待つ。
//
// スコア監視のアドレスはthprac_th13.cppより(score=0x4be7c0、stage=0x4be81c、
// lives=0x4be7f4、graze=0x4be7d0。スコアは内部値=表示値の1/10)。
// 画面上fps表示の低速補正(InstallFpsDisplayCorrectionHook)は未対応。

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
#include "../common/font_quality_hook.h"
#include "../common/d3d9_probe_hook.h"
#include "../common/d3dx_filter_hook.h"

using namespace autoplay;

// DirectInput scan codes.
static const BYTE DIK_DOWN = 0xD0;
static const BYTE DIK_RIGHT = 0xCD;
static const BYTE DIK_RETURN = 0x1C;

// 低速録画(フェーズ62、th10のreports/59・th20のreports/47と同じ方式)。
// th13.exeはd3d9.dll/DSOUND.dllを使う(インポートテーブルで確認済み)ため、
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
    Log("=== th13_replay_autoplay: AutoPlayThread started ===");

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

    Log("Buffering 10000ms (scaled) for title screen load...");
    ScaledSleep(10000);

    Log("Step 1: Down x3 (select 'Replay' on main menu)");
    for (int i = 0; i < 3; i++) {
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
    // placed as "th13_ud0000.rpy" in the instance's replay/ directory for
    // this Enter to land on the first user replay slot.
    Log("Step 4: Enter (select 1st user replay file)");
    PressKey(DIK_RETURN);
    ScaledSleep(700);

    Log("Step 5: Enter (confirm playback, start replay)");
    PressKey(DIK_RETURN);
    ScaledSleep(700);

    FrameSyncSetUnthrottled(true);

    Log("=== th13_replay_autoplay: sequence complete ===");
    return 0;
}

BOOL WINAPI DllMain(HINSTANCE hinst, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(hinst);
        LogInit(hinst, "th13_autoplay.log");
        Log("DLL_PROCESS_ATTACH: installing IAT hooks");
        InstallDinputHook();
        // 文字のジャギー調査(reports/101): FONT_QUALITY_PROBE=1 で CreateFontA の
        // 引数(face/height/weight/quality)をログに記録する(書き換えはしない)。
        // FONT_QUALITY_OVERRIDE=<n> を指定すると lfQuality を n に強制する。
        if (const char* q = getenv("FONT_QUALITY_OVERRIDE")) {
            InstallFontQualityHook((BYTE)atoi(q));
        } else if (getenv("FONT_QUALITY_PROBE")) {
            InstallFontQualityHook(FONT_QUALITY_NO_OVERRIDE);
        }
        // 倍速録画(reports/89): SPEED_HACK_MULTIPLIER未設定(等倍・低速)なら何もしない。
        InstallSpeedHackHook();
        // フレーム同期キャプチャ(reports/110)。InstallFpsLimiterHookより前に呼ぶ。
        InstallFrameSyncHook();
        InstallKeyboardStateHook();
        // 低速録画(フェーズ62)。FPS_LIMIT_TARGET_HZ未設定時はscale=1.0で
        // 従来動作と完全互換(th10・th20と同じ設計)。
        // D3D9の描画記録(reports/99・101)。D3D9_PROBE未設定なら何もしない。
        InstallD3D9ProbeHook();
        // D3DXLoadSurfaceFromMemoryの縮小フィルタの補完(reports/101)。環境変数が未設定なら何もしない。
        InstallD3DXFilterHook();
        InstallFpsLimiterHook(60.0);
        InstallDSoundHook(1.0);
        InstallDSoundProbeHook();
        // 画面上fpsカウンター表示の低速録画補正(フェーズ64追加調査)。
        // mods/common/timer_probe_hook.*での実測(TIMER_PROBE=1)により、
        // th13.exeのQueryPerformanceCounter呼び出し元のうちフレームごとに
        // 正確に3回呼ばれる箇所がrva=0x000508e8の1箇所のみと判明した
        // (th20のような「1回/フレームの内部自己スロットル用」と紛らわしい
        // 別候補は見つからなかった)。この1箇所のみを対象に実機検証済み
        // (reports/64参照、fps表示が「30.0fps」から「60.0fps」に変化することを
        // 目視確認)。
        // fps表示補正は未特定(th13は未対応)
        // リプレイずれ判定用のスコア等サンプリング。RVAはthprac
        // (thprac_th13.cpp)の`THAdvOptWnd`内の練習モードパラメータ書き込み
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
            sm.baseRva = 0xbe7c0;
            sm.baseIsPointer = false;
            sm.scoreOffset = 0x00;
            sm.scoreWidth = 4;
            sm.stageOffset = 0x5c;
            sm.stageWidth = 4;
            sm.livesOffset = 0x34;
            sm.livesWidth = 4;
            sm.grazeOffset = 0x10;
            sm.grazeWidth = 4;
            sm.intervalMs = 1000;
            StartScoreMonitorThread(sm);
        }
        StartFpsMonitorThread();
        CreateThread(NULL, 0, AutoPlayThread, NULL, 0, NULL);
    }
    return TRUE;
}
