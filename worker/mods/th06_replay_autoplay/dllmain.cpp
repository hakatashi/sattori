// th06 (Embodiment of Scarlet Devil / Koumakyou / TH06) replay auto-play MOD.
//
// Injects into 東方紅魔郷.exe and, after the title screen finishes loading,
// automatically navigates: (dismiss attract-mode demo) -> MainMenu -> Replay
// -> (1st replay file) -> (start playback), with no user interaction
// required.
//
// Unlike th07/th08, th06's title screen boots directly into an attract-mode
// demo replay ("DEMO PLAY") rather than showing the main menu, so an extra
// initial Enter press is needed to dismiss it before the Down/Enter sequence
// used by the other titles' MODs. Sequence provided by the user via manual
// playthrough on real Windows:
//   title screen (~2s logo animation wait) -> Enter (show menu) ->
//   Down x2 -> Enter (select "Replay", ~2s transition wait) ->
//   Enter (select 1st replay file, ~1s wait) -> Enter (start playback)
//
// th06 additionally requires the fan-made VsyncPatch (vpatch_th06.dll) to
// avoid a wined3d white-screen hang (see reports/30_phase30_th06_rendering_fix.md);
// that DLL must be injected into the same process alongside this one (see
// mods/tools/injector.cpp, which supports injecting multiple DLLs).
//
// See docs/touhou_menu_automation.md for the technical background
// (DirectInput GetDeviceState vtable hook), shared with the th07/th08 MODs.

#include "autoplay/title_main.h"
#include "clock/fps_display.h"
#include "present/capture/d3d8_readback.h"

using namespace autoplay;

namespace {

const MenuStep kMenu[] = {
    {.key = Key::kReturn, .waitMs = 500, .label = "Enter (dismiss attract-mode demo, show main menu)"},
    {.key = Key::kDown, .repeat = 2, .waitMs = 250, .label = "Down x2 (select 'Replay' on main menu)"},
    {.key = Key::kReturn, .waitMs = 2000, .label = "Enter (confirm 'Replay', enter replay list)"},
    {.key = Key::kReturn, .waitMs = 1000, .label = "Enter (select 1st replay file)"},
    {.key = Key::kReturn, .waitMs = 700, .label = "Enter (start replay playback)"},
};

const TitleSpec kSpec = {
    .name = "th06",
    .titleWaitMs = 2000,
    .menu = kMenu,
    .installFrameSync = InstallFrameSyncD3D8,
    .frameSyncStepDiv = 1024,
    // 画面上fpsカウンター表示の倍速録画補正(reports/90)。th06のfps計算
    // (RVA 0x23f3f〜、書式"%.02ffps")はWINMM.dll!timeGetTimeで経過時間を測る
    // (0x23f5d=初回のみ基準時刻、0x23f68=毎フレーム現在時刻、500ms毎に更新)。
    // clock/speed_hackはQPCしか偽装しないため、補正しないと2倍速(vpatch GameFPS=120)で
    // 「120.00fps」と表示される。両呼び出しの戻り先RVAを対象にする。
    // なおvpatch.iniのCalcFPS=1だとvpatch自身がfpsを計算・表示するため、倍速録画時は
    // recording/instance.pyがCalcFPS=0に書き換える。
    .realtimeExtra = [] {
        static const ULONG_PTR kFpsTimeRvas[] = {0x00023f63, 0x00023f6e};
        InstallFpsDisplayCorrectionHookTimeGetTime(kFpsTimeRvas, 2);
    },
    // リプレイずれ判定用のスコア等サンプリング(Issue #103)。RVAはthprac
    // (thprac_th06.cpp)の`GAME_MANAGER = (GameManager*)0x69bca0`(絶対VA、
    // ImageBase=0x400000前提、RVA=0x29bca0)由来。GameManager構造体はポインタ
    // 間接参照不要で直接この位置にある。score(uint32, +0x04)は画面表示値と
    // 等倍(th07/th11/th20と異なりth06は10倍換算不要)。livesRemaining(int8,
    // +0x181a)は1バイトのみである点に注意。フル尺録画でリプレイ記録スコアとの
    // 完全一致を実機確認済み(touhou-recorder
    // reports/53_phase53_score_monitor_all_titles.md)。
    .scoreMonitor = {
        .baseRva = 0x29bca0,
        .scoreOffset = 0x04,
        .scoreWidth = 4,
        .stageOffset = 0x1a34,
        .stageWidth = 4,
        .livesOffset = 0x181a,
        .livesWidth = 1,
        .grazeOffset = 0x18,  // grazeInTotal(累積グレイズ)
        .grazeWidth = 4,
    },
};

}  // namespace

DEFINE_TITLE(kSpec)
