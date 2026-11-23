// th07 (East New World / Youyoumu / TH07) replay auto-play MOD.
//
// Injects into th07.exe and, after the title screen finishes loading,
// automatically navigates: MainMenu -> Replay -> (1st replay file) ->
// (default start stage) -> (normal playback mode), with no user
// interaction required.
//
// See docs/touhou_menu_automation.md for the technical background
// (DirectInput GetDeviceState vtable hook) and reports/07_*.md for the
// verification log of this specific MOD.

#include "autoplay/title_main.h"
#include "present/capture/d3d8_readback.h"

using namespace autoplay;

namespace {

const MenuStep kMenu[] = {
    {.key = Key::kDown, .repeat = 2, .waitMs = 250, .label = "Down x2 (select 'Replay' on main menu)"},
    {.key = Key::kReturn, .waitMs = 700, .label = "Enter (confirm 'Replay', enter replay list)"},
    {.key = Key::kReturn, .waitMs = 700, .label = "Enter (select 1st replay file)"},
    {.key = Key::kReturn, .waitMs = 700, .label = "Enter (select default start stage)"},
    {.key = Key::kReturn, .waitMs = 700, .label = "Enter (select normal playback mode, start replay)"},
};

const TitleSpec kSpec = {
    .name = "th07",
    .titleWaitMs = 1500,
    .menu = kMenu,
    .installFrameSync = InstallFrameSyncD3D8,
    .frameSyncStepDiv = 32,
    // リプレイずれ判定用のスコア等サンプリング(Issue #103)。
    //
    // Sattoriが配布しているth07.exe(ver 1.00b、650752バイト)は
    // touhou-recorderがフェーズ53で検証に使ったth07.exe(ver 1.00、
    // 607744バイト、公式パッチ適用前)とバイナリが異なり、当初
    // フェーズ53のRVA(`0x21c250`、旧バイナリ向けの補正値)では
    // `GAME_MANAGER->globals`が常に0のままでスコアが一切取得できなかった
    // (Issue #168)。
    //
    // touhou-recorderのフェーズ54で、ver1.00bのゲームデータ
    // (`games/th07_ver100b/`、Sattoriと同一バイナリ)を使って再調査した
    // 結果、**ver1.00bについてはthprac記載のGAME_MANAGER絶対VA
    // `0x626270`(RVA `0x226270`)がそのまま正しい**ことが判明した
    // (ステージ番号RVAの実測値`0x22f85c`が、`0x226270 + 0x95ec`という
    // thprac側のオフセットからの予測値と1バイトの狂いもなく一致した
    // ことで裏付け済み)。フェーズ53で「thprac記載の値は誤り」としていた
    // のは、検証に使った旧バイナリがthpracの対象(ver1.00b)と単に違って
    // いただけだった。true_score(int32, globals+0x4)は画面表示値の1/10
    // (th11/th20と同じ慣習)。life_countはfloat(破片管理のため)。
    // フル尺録画でリプレイ記録スコアとの完全一致を実機確認済み
    // (touhou-recorder
    // reports/54_phase54_th07_ver100b_reverification.md)。
    .scoreMonitor = {
        .baseRva = 0x226270 + 0x8,  // GAME_MANAGER(thprac記載のまま)->globals フィールド
        .baseIsPointer = true,
        .scoreOffset = 0x04,  // true_score
        .scoreWidth = 4,
        .livesOffset = 0x5c,  // life_count
        .livesWidth = 4,
        .livesIsFloat = true,
        .grazeOffset = 0x18,
        .grazeWidth = 4,
    },
};

}  // namespace

DEFINE_TITLE(kSpec)
