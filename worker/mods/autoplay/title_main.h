#pragma once
#include <windows.h>

#include <span>

#include "autoplay/menu_script.h"
#include "monitor/score_monitor.h"

// 32bitタイトル(th06〜th20、th128)の自動再生MODの共通部(Issue #394)。
//
// どのタイトルの `dllmain.cpp` も同じ流れだった:
//   LogInit → InitRuntimeConfig → 入力フック → (文字フィルタ) → フレーム同期、なければ倍速録画の
//   フック → DirectSoundフック → ScoreMonitor → AutoPlayThread
//   (ウィンドウの安定待ち → 入力フックの有効化待ち → タイトル画面の待ち → メニュー操作)。
// タイトルごとの違いは `TitleSpec` という宣言に出し、流れは `autoplay::TitleDllMain` が持つ。
// 各タイトルの `dllmain.cpp` は `TitleSpec` を書いて `DEFINE_TITLE(spec)` するだけにする。
//
// **宣言に収まらない本当にタイトル固有の処理だけ**を `realtimeExtra` に置く
// (th12 の fps 表示のコードケーブなど)。**ここにタイトルの分岐を足さないこと**。
// DXライブラリ系の th06c・th06nc は起動の流れ(起動ダイアログ・WaitForStableWindow の種類・
// 入力ポーリングの待ち)が違うので `TitleSpec` を使わず、メニュー操作だけ
// `autoplay/menu_script.h` を共有する。

namespace autoplay {

// メニュー操作のキーを注入する経路。どちらも input/dinput の DirectInput フックを入れる
// (経路の判別はタイトルごとに実機で確かめてある。titles/thNN.md)。
enum class InputPath {
    // IDirectInputDevice8::GetDeviceState の注入(PressKey、DIKスキャンコード)。th06〜th10・th12〜th15・th128
    kDInput,
    // GetKeyboardState の IAT フックの注入(PressVKey、仮想キー)。th11・th20
    kKeyboardState,
};

struct TitleSpec {
    // タイトルID。ログのファイル名(`<name>_autoplay.log`)と `sequence complete` 行に使う
    const char* name;

    InputPath input = InputPath::kDInput;

    // --- メニュー操作 ---
    // タイトル画面の待ち(MenuSleep の基準時間)。フレーム同期時だけ別の値にするなら
    // titleWaitMsFrameSync(0なら同じ)。タイトルのロゴ演出中に送った入力は無視されるので、
    // 短くしてよいかはタイトルごとに実機で確かめること
    DWORD titleWaitMs = 0;
    DWORD titleWaitMsFrameSync = 0;
    // 最初の Step の番号(th10 だけ 0。ワーカーは `Step N:` の最後の行しか見ない)
    int firstStep = 1;
    std::span<const MenuStep> menu;

    // --- フック(組み込む順に並べてある) ---
    // 文字の縮小フィルタ(texture/d3dx_filter、th10・th11・th12・th128・th13)
    int (*textFilter)() = nullptr;
    // フレーム同期(present/capture/*_readback)のバックエンドと stepDiv。
    // FRAME_SYNC_PIPE 未設定なら false を返して何もしないので、続けて倍速録画用のフックを入れる
    bool (*installFrameSync)(int stepDiv) = nullptr;
    int frameSyncStepDiv = 0;
    // --- 以下は installFrameSync が false(=実時間の録画)のときだけ入れる ---
    // Present の上限(present/limiter)。D3D9 は InstallFpsLimiterHook、D3D8(th09)は D3D8 版。
    // 無ければ入れない(th06〜th08・th11 は VsyncPatch・ゲーム側が 60fps を制御する)
    bool (*installLimiter)() = nullptr;
    // true なら FPS_LIMIT_TARGET_HZ が 60 以外(倍速)のときだけ上限を入れる。**等倍では入れない**:
    // VsyncPatch が 60fps を制御するタイトル(th10・th12)では二重の制御でゲーム進行が遅れる
    bool limiterOnlyWhenScaled = false;
    // 倍速録画の画面上 fps 表示の補正(clock/fps_display)など、実時間の録画だけのタイトル固有の処理。
    // InstallSpeedHackHook・上限の**後**に呼ぶ。引数の無い関数にして、条件はその中で見る
    void (*realtimeExtra)() = nullptr;

    // --- スコア監視(monitor/score_monitor、リプレイずれの事後検知) ---
    ScoreMonitorConfig scoreMonitor;
};

// DllMain の本体。DLL_PROCESS_ATTACH で上の流れのフックを入れ、AutoPlayThread を起動する。
// spec は DLL の寿命の間ずっと参照するので static にすること(DEFINE_TITLE が保証する)。
BOOL TitleDllMain(const TitleSpec& spec, HINSTANCE hinst, DWORD reason);

}  // namespace autoplay

#define DEFINE_TITLE(spec)                                                    \
    BOOL WINAPI DllMain(HINSTANCE hinst, DWORD reason, LPVOID) {              \
        return ::autoplay::TitleDllMain(spec, hinst, reason);                 \
    }
