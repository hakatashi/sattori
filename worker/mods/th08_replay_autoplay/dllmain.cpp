// th08 (Imperishable Night / Eiyashou / TH08) replay auto-play MOD.
//
// Injects into TH08.EXE and, after the title screen finishes loading,
// automatically navigates: MainMenu -> Replay -> (1st replay file) ->
// (default start stage) -> (normal playback mode), with no user
// interaction required.
//
// Identical in structure to mods/th07_replay_autoplay/dllmain.cpp; the only
// functional difference is the number of Down presses needed to reach
// "Replay" on th08's main menu (2, per the current game config).
//
// See docs/touhou_menu_automation.md for the technical background
// (DirectInput GetDeviceState vtable hook) and reports/08_*.md for the
// verification log of this specific MOD.

#include "autoplay/title_main.h"
#include "clock/fps_display.h"
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
    .name = "th08",
    .titleWaitMs = 1500,
    .menu = kMenu,
    .installFrameSync = InstallFrameSyncD3D8,
    .frameSyncStepDiv = 32,
    // 画面上fpsカウンター表示の倍速録画補正(reports/90)。th08(ver1.00d)の
    // fps計算(書式"%.02ffps"、RVA 0x47031で参照)はWINMM.dll!timeGetTimeで経過時間を
    // 測る(0x46fa7=初回のみ基準時刻、0x46fb2=毎フレーム現在時刻、500ms毎に更新)。
    // clock/speed_hackはQPCしか偽装しないため、補正しないと2倍速で「120.00fps」と
    // 表示される。
    .realtimeExtra = [] {
        static const ULONG_PTR kFpsTimeRvas[] = {0x00046fad, 0x00046fb8};
        InstallFpsDisplayCorrectionHookTimeGetTime(kFpsTimeRvas, 2);
    },
    // リプレイずれ判定用のスコア等サンプリング(Issue #103)。RVAはthprac
    // (thprac_th08.cpp)の`GetMemAddr`ヘルパが辿るプレイヤー状態構造体への
    // ポインタ変数(絶対VA 0x160f510、RVA=0x120f510)由来。1段階のポインタ間接
    // 参照が必要。score/graze(いずれもint32)は画面表示値の1/10(th07/th11/th20
    // と同じ慣習。導入当初は「th06と同じく等倍」と予想していたが誤りだった)。
    // life(float、破片管理)。フル尺録画でリプレイ記録スコアとの完全一致を
    // 実機確認済み(touhou-recorder
    // reports/53_phase53_score_monitor_all_titles.md)。
    // スコア欄は+0x08(真値、スペルカード取得で記録スコアへ一度に跳ねる)。+0x00は表示用の
    // 追っかけ値で、数フレームかけて真値に近づく途中でリプレイが終わって構造体が解放され、
    // 記録スコアに届かないことがある(docs/reports/2026-11-24-desync-false-positive-investigation.md §4.1)。
    .scoreMonitor = {
        .baseRva = 0x120f510,
        .baseIsPointer = true,
        .scoreOffset = 0x08,
        .scoreWidth = 4,
        .livesOffset = 0x74,
        .livesWidth = 4,
        .livesIsFloat = true,
        .grazeOffset = 0x04,
        .grazeWidth = 4,
    },
};

}  // namespace

DEFINE_TITLE(kSpec)
