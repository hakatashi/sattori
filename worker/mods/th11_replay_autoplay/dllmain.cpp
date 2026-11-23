// th11 (Subterranean Animism / Chireiden / TH11) replay auto-play MOD.
//
// Injects into th11.exe and, after the title screen finishes loading,
// automatically navigates: MainMenu -> Replay -> (user replay tab) ->
// (1st user replay file) -> (confirm playback), with no user interaction
// required.
//
// Structurally similar to mods/th08_replay_autoplay/dllmain.cpp, but th11
// (TH10+ engine) does NOT poll input via DirectInput GetDeviceState like
// th06/07/08 do -- CreateDevice is called (so the DirectInput hook chain
// installs successfully) but GetDeviceState is never actually invoked
// (confirmed via FpsMonitor showing 0 Hz indefinitely). Real per-frame
// input polling goes through the plain Win32 GetKeyboardState() API
// instead, so this MOD injects via that hook (PressVKey) rather than
// PressKey/DIK codes. See touhou-recorder reports/35 for the verification
// log that found this and mods/input/dinput.h for the added hook.
//
// The replay list screen has two tabs: the built-in numbered slots
// (No.01-No.24, th11_01.rpy style filenames) and a separate "user replay"
// tab (th11_ud0000.rpy style filenames) reached by pressing Right once.
// This MOD targets the user replay tab, since that's where actual
// player-recorded replays belong: Down x2 -> Enter(Replay) ->
// Right(switch to user replay tab) -> Enter(select 1st user replay file)
// -> Enter(confirm playback).

#include "autoplay/title_main.h"
#include "present/capture/d3d9_readback.h"
#include "texture/d3dx_filter.h"

using namespace autoplay;

namespace {

const MenuStep kMenu[] = {
    {.key = Key::kDown, .repeat = 2, .waitMs = 250, .label = "Down x2 (select 'Replay' on main menu)"},
    {.key = Key::kReturn, .waitMs = 700, .label = "Enter (confirm 'Replay', enter replay list)"},
    {.key = Key::kRight, .waitMs = 500, .label = "Right (switch to user replay tab)"},
    {.key = Key::kReturn, .waitMs = 700, .label = "Enter (select 1st user replay file)"},
    {.key = Key::kReturn, .waitMs = 700, .label = "Enter (confirm playback, start replay)"},
};

const TitleSpec kSpec = {
    .name = "th11",
    .input = InputPath::kKeyboardState,
    // th08 only needs 1500ms here; th11's title logo animation is longer and
    // sending Down/Enter too early lands on the wrong menu item (Practice
    // Start, Rank Select, etc.) instead of "Replay". 6000ms (8000ms for
    // frame-sync) was found to reliably reach the main menu.
    .titleWaitMs = 6000,
    .titleWaitMsFrameSync = 8000,
    .menu = kMenu,
    // D3DXLoadSurfaceFromMemoryの縮小フィルタ補完(文字のジャギー対策、touhou-recorder
    // reports/101・102)。既定で有効(D3DX_AREA_FILTER=0で無効)。
    .textFilter = InstallD3DXFilterHook,
    .installFrameSync = InstallFrameSyncD3D9,
    .frameSyncStepDiv = 1024,
    // リプレイずれ判定用のスコア等サンプリング(Issue #103)。RVAはthprac
    // (thprac_th11.cpp)の`Globals* globals = (Globals*)0x4a56e0`(絶対VA、
    // RVA=0xa56e0)由来。th20と同じくポインタ間接参照は不要(構造体自体が固定
    // RVAに置かれている)。score(int32, +0x04)は画面表示値の1/10(th07/th20と
    // 同じ慣習)。stage(+0x48)はthprac側の`STAGE_NUM`列挙値(=globals+0x48)と
    // 一致することを構造体オフセット計算で裏付け済み。フル尺録画でリプレイ
    // 記録スコアとの完全一致を実機確認済み(touhou-recorder
    // reports/53_phase53_score_monitor_all_titles.md、ゲームオーバーで終わる
    // リプレイでも最終スコアが記録値と厳密に一致することまで確認済み)。
    .scoreMonitor = {
        .baseRva = 0xa56e0,
        .scoreOffset = 0x04,
        .scoreWidth = 4,
        .stageOffset = 0x48,
        .stageWidth = 4,
        .livesOffset = 0x38,
        .livesWidth = 4,
        .grazeOffset = 0x74,
        .grazeWidth = 4,
    },
};

}  // namespace

DEFINE_TITLE(kSpec)
