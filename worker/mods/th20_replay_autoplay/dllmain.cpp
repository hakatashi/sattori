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

#include "autoplay/title_main.h"
#include "clock/fps_display.h"
#include "present/capture/d3d9_readback.h"
#include "present/limiter.h"

using namespace autoplay;

namespace {

const MenuStep kMenu[] = {
    {.key = Key::kDown, .repeat = 3, .waitMs = 250, .label = "Down x3 (select 'Replay' on main menu)"},
    {.key = Key::kReturn, .waitMs = 700, .label = "Enter (confirm 'Replay', enter replay list)"},
    {.key = Key::kRight, .waitMs = 500, .label = "Right (switch to user replay tab)"},
    {.key = Key::kReturn, .waitMs = 700, .label = "Enter (select 1st user replay file)"},
    {.key = Key::kReturn, .waitMs = 700, .label = "Enter (confirm playback, start replay from Stage 1)"},
};

const TitleSpec kSpec = {
    .name = "th20",
    .input = InputPath::kKeyboardState,
    // 実機検証(reports/44参照)で、th20のタイトルロゴアニメーションから
    // メニュー項目(Game Start等のテキスト)が実際に操作可能になるまでは
    // 従来タイトル(th11等)より大幅に長く、5000ms程度の待機ではメニューが
    // まだ表示されておらず最初の数回のDown入力が空振りすることを確認した。
    // 10000ms待つことで確実にメニュー表示後からDown x3を開始できる。
    .titleWaitMs = 10000,
    .menu = kMenu,
    .installFrameSync = InstallFrameSyncD3D9,
    .frameSyncStepDiv = 1024,
    // AWS実機(Intel Xeon/Nitro仮想化)でth20のフレームペーシングが崩れ、
    // ゲーム内fpsカウンターが常時75fps前後(本来60fps)になりリプレイが
    // 早回しになる不具合への対策(フェーズ46追加調査、詳細はpresent/limiter.h参照)。
    .installLimiter = InstallFpsLimiterHook,
    // th20自身のfpsカウンター表示がスローモーション化(FPS_LIMIT_TARGET_HZ)
    // に連動して低い値を表示してしまう問題(reports/47の既知の制約)への対策。
    // 表示計算に使われていることを実証済みの特定コールサイトのみ時刻の
    // 進み方を補正し、等倍相当のfps値を表示させる(reports/48参照)。
    .realtimeExtra = [] { InstallFpsDisplayCorrectionHook(0x0001cb54); },
    // リプレイずれ判定用に、ゲーム内スコア・ステージ番号・残機・グレイズを
    // 1秒間隔でMODログへ出力する(Issue #103、reports/50)。
    // RVAはthpracのthprac_th20.cpp(rel_addrs::GAME_SIDE0 = 0x1ba568 と
    // GlobalsSide構造体)由来。GlobalsSide本体は RVA(GAME_SIDE0 + 0x88) に
    // 直に置かれており、score(uint64)がその先頭、life_stocksが+0xb8、
    // grazeが+0xe4、ステージ番号が+0x1f4。th20 ver1.00cで検証済み。フル尺録画で
    // リプレイ記録スコアとの完全一致を実機確認済み(reports/50、
    // touhou-recorder reports/53_phase53_score_monitor_all_titlesで
    // score_monitor.hの構造体リファクタ後もリグレッション無しを再確認済み)。
    .scoreMonitor = {
        .baseRva = 0x1ba568 + 0x88,
        .scoreOffset = 0x00,
        .scoreWidth = 8,
        .stageOffset = 0x1f4,
        .stageWidth = 4,
        .livesOffset = 0xb8,
        .livesWidth = 4,
        .grazeOffset = 0xe4,
        .grazeWidth = 4,
    },
};

}  // namespace

DEFINE_TITLE(kSpec)
