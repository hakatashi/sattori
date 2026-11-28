// th09 (東方花映塚 / Phantasmagoria of Flower View, TH09) replay auto-play MOD.
//
// Injects into th09.exe and, after the title screen finishes loading,
// automatically navigates: MainMenu -> Replay -> (switch to user-replay tab)
// -> (1st replay file) -> (confirm playback), with no user interaction
// required.
//
// th09はth06/07/08と同じ世代のエンジンで、DirectInputのGetDeviceStateが
// 実ポーリング経路であることを実機確認済み(touhou-recorder reports/68の
// FpsMonitorログで起動直後から100Hz超のGetDeviceState呼び出しを確認、th12の
// 教訓通りGetKeyboardState方式ではないことを確かめてからPressKeyに決めた)。
//
// メニュー操作シーケンス(ユーザー提供、touhou-recorder reports/68):
//   Down x2 -> Enter(「Replay」選択、直ちにリプレイ選択画面へ遷移)
//   -> Right x1(ユーザーリプレイタブへ切替) -> Enter(1番目のリプレイ選択)
//   -> Enter(再生確定)
// th11/th12/th20と同じ「ud0000タブ」方式のため、record_th09.py側で
// コピー先ファイル名を常に"th9_ud0000.rpy"に正規化する(GameConfig.canonical_slot)。
// 実行ファイル名はth09.exeだが、リプレイファイル名の接頭辞は"th9_"
// (th09ではなくth9)である点に注意(実機検証で判明)。

#include "autoplay/title_main.h"
#include "clock/fps_display.h"
#include "present/capture/d3d8_readback.h"
#include "present/limiter.h"

using namespace autoplay;

namespace {

const MenuStep kMenu[] = {
    {.key = Key::kDown, .repeat = 2, .waitMs = 250, .label = "Down x2 (select 'Replay' on main menu)"},
    {.key = Key::kReturn, .waitMs = 700, .label = "Enter (confirm 'Replay', enter replay list)"},
    {.key = Key::kRight, .waitMs = 400, .label = "Right (switch to user-replay tab)"},
    {.key = Key::kReturn, .waitMs = 700, .label = "Enter (select 1st replay file)"},
    {.key = Key::kReturn, .waitMs = 700, .label = "Enter (confirm playback, start replay)"},
};

const TitleSpec kSpec = {
    .name = "th09",
    .titleWaitMs = 1500,
    .menu = kMenu,
    .installFrameSync = InstallFrameSyncD3D8,
    .frameSyncStepDiv = 32,
    // Presentの上限(present/limiter)。th09はDirect3D8エンジンのため、D3D8のアダプタを使う。
    // 倍速録画ではPresentの上限を60×倍率へ引き上げる。FPS_LIMIT_TARGET_HZ未設定時は
    // 60fpsの上限。
    .installLimiter = InstallFpsLimiterHookD3D8,
    // 低速録画時の画面上fpsカウンター表示補正(touhou-recorder reports/69)。
    // th09はtouhou-recorder の `mods/common/timer_probe_hook.*`による調査の結果、th20と異なり
    // QueryPerformanceCounterではなくWINMM.dll!timeGetTime(rva=0x00031701、
    // Present呼び出し頻度と1:1で相関する唯一の持続的なtimeGetTime呼び出し元)が
    // fps表示計算に使われていることが判明した。FPS_LIMIT_TARGET_HZ未設定時は
    // scale=1.0で実質無効化。
    .realtimeExtra = [] { InstallFpsDisplayCorrectionHookTimeGetTime(0x00031701); },
    // P1残機の監視(Issue #103の枠組み、touhou-recorder reports/68)。
    // thprac(thprac_th09.cpp)のTH09Toolsから収集したRVA(絶対VA 0x4a7d94、
    // image base 0x400000)を基点(RVA=0xa7d94)としたポインタ間接参照で、
    // +0xa8がlife(0.5刻みの残機を2倍した整数、1〜10)。
    //
    // スコアはthprac_th09.cppにスコア表示/編集UIが無く既知のRVAが得られず、
    // 実機でのメモリ全域スキャン(プレイヤー構造体・弾幕マネージャ構造体・
    // BSS領域をint32/int64/floatで解釈)でも表示スコアと一致するアドレスを
    // 発見できなかった(touhou-recorder reports/68)。scoreWidth=0を指定し
    // スコア読み取り自体をスキップする(score_monitor.h参照)。P2側は
    // ScoreMonitorConfigが単一のstage/lives/graze欄しか持たない構造上、
    // 今回は自分側(P1)のみ監視する。
    .scoreMonitor = {
        .baseRva = 0xa7d94,
        .baseIsPointer = true,
        .scoreWidth = 0,
        .livesOffset = 0xa8,
        .livesWidth = 4,
    },
};

}  // namespace

DEFINE_TITLE(kSpec)
