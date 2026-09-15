// th128(妖精大戦争 ～ 東方三月精 / Fairy Wars)の自動再生MOD。
//
// メインメニュー -> Replay -> (ユーザーリプレイタブへ切替) -> (1番目選択) -> (再生確定)
// を自動操作する。th128はメインシリーズと同じ上海アリス幻樂団(ZUN)制作の外伝作品で
// (黄昏フロンティアの格闘ゲームシリーズとは別)、TH10エンジンをベースにしている
// (thprac側のthprac_th128.cppがth10用のトラッカーコールバックをそのまま再利用して
// いることから示唆され、実機検証でも入力方式が一致した)。
//
// - 入力注入経路はth10/th12と同じPressKey(DIKスキャンコード経由)。DirectInputの
//   GetDeviceStateが実際に55〜60Hzでポーリングされることを実機確認済み(FpsMonitorログ、
//   touhou-recorder reports/70)。
// - メニュー操作シーケンス自体はth11/th12と異なりDown x1のみ(th128のメインメニューは
//   Replayのカーソル位置がth11/th12よりひとつ浅い)。
//
// **thprac(record_th128.pyのthprac_exe経由でアタッチ)が無いと録画できない**:
// リプレイ選択画面で1番目のユーザーリプレイを確定するEnterの直後、GetDeviceStateの
// 呼び出しが完全に停止しゲーム本体が無限ループに入ってフリーズする既知バグがある
// (Windows実機でも再現するゲーム本体側の既知バグとユーザーから確認済み)。thpracを
// 経由して起動するだけで解消することを実機確認済み(touhou-recorder reports/70)。
// th20と同じ理由で、record_th128.pyのthprac_exe指定を外さないこと。

#include <windows.h>
#include <stdlib.h>
#include "../common/dinput_hook.h"
#include "../common/window_wait.h"
#include "../common/logging.h"
#include "../common/fps_monitor.h"
#include "../common/fps_limiter_hook.h"
#include "../common/dsound_hook.h"
#include "../common/score_monitor.h"

using namespace autoplay;

// DirectInput scan codes.
static const BYTE DIK_DOWN = 0xD0;
static const BYTE DIK_RIGHT = 0xCD;
static const BYTE DIK_RETURN = 0x1C;

// 低速録画対応(th10・th12・th20と同じ方式)。FPS_LIMIT_TARGET_HZ未設定時はscale=1.0で
// 従来動作と完全互換(30fpsでの実機検証はtouhou-recorder reports/72で完了済みだが、
// Sattori側のSLOW_MOTION_SUPPORTED_GAME_IDSには未登録、worker/docs/titles/th128.md)。
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
        Log("ERROR: GetDeviceState hook was never called, aborting sequence");
        return 1;
    }

    // タイトル画面表示後、最大10秒程度までキー入力を受け付けないことがある
    // (ユーザー申告、touhou-recorder reports/70)という懸念から当初8000msを取っていたが、
    // sattori本体での実機検証(docs/reports/2026-09-16-th128-title-screen-wait-reduction-verification.md)
    // で2000msでもシーケンスが安定して成功することを確認し、短縮した。
    Log("Buffering 2000ms (scaled) for title screen load...");
    ScaledSleep(2000);

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
    // replay/ディレクトリへ"th128_ud0000.rpy"として配置されている必要がある
    // (record_th128.pyのcanonical_slot)。
    Log("Step 4: Enter (select 1st user replay file)");
    PressKey(DIK_RETURN);
    ScaledSleep(700);

    Log("Step 5: Enter (confirm playback, start replay)");
    PressKey(DIK_RETURN);
    ScaledSleep(700);

    Log("=== th128_replay_autoplay: sequence complete ===");
    return 0;
}

BOOL WINAPI DllMain(HINSTANCE hinst, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(hinst);
        LogInit(hinst, "th128_autoplay.log");
        Log("DLL_PROCESS_ATTACH: installing IAT hooks");
        InstallDinputHook();
        // 低速録画用フック。FPS_LIMIT_TARGET_HZ未設定時はscale=1.0で従来動作と完全互換
        // (touhou-recorder reports/72で30fps実機検証済み)。
        InstallFpsLimiterHook(60.0);
        InstallDSoundHook(1.0);
        // リプレイずれ判定用のスコア等サンプリング(Issue #103)。RVAはthprac
        // (thprac_th128.cppの`th128_patch_main`フック内で練習モードの初期値を
        // ゲーム内変数へ直接書き込んでいる箇所)の絶対VA(image base 0x400000)から収集し、
        // 基点0x4b4c00(RVA=0xb4c00)からのオフセットに整理したもの。フル尺録画
        // (通常・Extra両方)で記録スコアとの完全一致を実機確認済み(touhou-recorder reports/71)。
        //   score:      +0xc4 (画面表示値の1/10、th10/th12と同じ×10系列)
        //   motivation: +0x164(「やる気」ゲージ、残機に相当。表示値は生値/100)
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
