// th14 (東方輝針城 / Double Dealing Character, TH14, ver1.00b・非Steam版) replay auto-play MOD.
//
// th14.exeに注入し、タイトル画面のロード後に
//   Down x3 -> Enter(Replay) -> Right(ユーザーリプレイタブ) -> Enter(先頭スロット選択) -> Enter(再生)
// を自動で行う。Extraモード未解放のため「Extra Start」はスキップされ、ReplayへはDown x3になる
// (th13と同じ)。th14.exeはDINPUT8・DSOUND・d3d9をインポートし、th13/th15と同じく
// GetDeviceStateで入力を読むのでPressKey(DIKコード)で注入する(touhou-recorder reports/103)。
//
// cfg/リプレイは%APPDATA%/ShanghaiAlice/th14/から読まれる。呼び出し側(record_th14.py)は
// 投入リプレイを"th14_ud0000.rpy"へ正規化すること(ユーザーリプレイタブの先頭スロット)。
// th14.cfgのオフセット0x39が1だと起動時に解像度選択ダイアログが出て止まる(0にしておくこと)。

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
#include "present/capture/d3d9_readback.h"
#include "present/capture/frame_sync.h"
#include "present/limiter.h"

using namespace autoplay;

// DirectInput scan codes.
static const BYTE DIK_DOWN = 0xD0;
static const BYTE DIK_RIGHT = 0xCD;
static const BYTE DIK_RETURN = 0x1C;

static DWORD WINAPI AutoPlayThread(LPVOID) {
    Log("=== th14_replay_autoplay: AutoPlayThread started ===");

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

    // 起動直後はロード中画面がタイトル画面と誤認されうるので10秒待つ(th15・th20と同じ)。
    // この区間は配信版でカットされる(`recording/cut.py`)ので、長くても動画には残らない。
    const DWORD titleWaitMs = frame_sync::Active() ? 11500 : 10000;
    Log("Buffering %lums (scaled) for title screen logo animation...", (unsigned long)titleWaitMs);
    time_scale::MenuSleep(titleWaitMs);

    LogStep(1, "Down x3 (select 'Replay' on main menu)");
    for (int i = 0; i < 3; i++) {
        PressKey(DIK_DOWN);
        time_scale::MenuSleep(250);
    }

    LogStep(2, "Enter (confirm 'Replay', enter replay list)");
    PressKey(DIK_RETURN);
    time_scale::MenuSleep(700);

    LogStep(3, "Right (switch to user replay tab)");
    PressKey(DIK_RIGHT);
    time_scale::MenuSleep(500);

    LogStep(4, "Enter (select 1st user replay file)");
    PressKey(DIK_RETURN);
    time_scale::MenuSleep(700);

    LogStep(5, "Enter (confirm playback, start replay from Stage 1)");
    PressKey(DIK_RETURN);
    time_scale::MenuSleep(700);

    frame_sync::SetUnthrottled(true);
    LogSequenceComplete("th14");
    return 0;
}

BOOL WINAPI DllMain(HINSTANCE hinst, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(hinst);
        LogInit(hinst, "th14_autoplay.log");
        InitRuntimeConfig();
        Log("DLL_PROCESS_ATTACH: installing IAT hooks");
        InstallDinputHook();
        if (!InstallFrameSyncD3D9(1024)) {
            // 倍速録画(reports/85・89): QPCの経過時間をSPEED_HACK_MULTIPLIER倍に伸ばす。
            // 未設定(等倍)なら何もしない。
            InstallSpeedHackHook();
            // D3D9 Presentフックでフレームレートを60fpsに制限する(th15と同じ)。
            InstallFpsLimiterHook();
            // 低速録画でfps表示が低いままになる問題の補正(th15と同じ構造、touhou-recorder
            // reports/93・103)。fpsの更新(0x2e4d0)が時刻取得関数(0x6ac20)を呼ぶ経路(戻り先
            // 0x2e4e0)だけを偽装する。0x6ac20内のQueryPerformanceCounterの戻り先は0x6ac5e。
            // 等倍・倍速録画では倍率1.0となり無効。IATの外側に置くためInstallSpeedHackHookより
            // 後に呼ぶこと。
            InstallFpsDisplayCorrectionHookViaCaller(0x0006ac5e, 0x0002e4e0);
        }
        // present/limiterによる映像・ゲームロジックのスローモーション化は
        // DirectSoundのBGM/SEストリーミングには連動しないため、SetFrequency
        // フックで音声側も同じ比率でスケールする(th20と同じ理由)。
        InstallDSoundHook();
        // リプレイずれ判定用のスコア等サンプリング(Issue #103)。RVAはthprac(thprac_th14.cpp)の
        // 絶対VAからimage base(0x400000)を引いたもの:
        //   score: 0x4f5830 (+0x00、内部値=表示値の1/10)
        //   graze: 0x4f5840 (+0x10)
        //   lives: 0x4f5864 (+0x34)
        //   stage: 0x4f58a4 (+0x74、1始まり。Extraは7)
        // 通常(Lunatic全クリア)・Extraのフル尺録画で記録スコアとの完全一致を確認済み
        // (touhou-recorder reports/103・110)。
        {
            ScoreMonitorConfig sm;
            sm.baseRva = 0xf5830;
            sm.baseIsPointer = false;
            sm.scoreOffset = 0x00;
            sm.scoreWidth = 4;
            sm.stageOffset = 0x74;
            sm.stageWidth = 4;
            sm.livesOffset = 0x34;
            sm.livesWidth = 4;
            sm.grazeOffset = 0x10;
            sm.grazeWidth = 4;
            sm.intervalMs = 1000;
            StartScoreMonitorThread(sm);
        }
        CreateThread(NULL, 0, AutoPlayThread, NULL, 0, NULL);
    }
    return TRUE;
}
