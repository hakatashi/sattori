// th13(東方神霊廟 ～ Ten Desires.、ver1.00c・非Steam版)の自動再生MOD。
//
// メインメニュー -> Replay -> (ユーザーリプレイタブへ切替) -> (1番目選択) -> (再生確定)
// を自動操作する(touhou-recorder reports/100で実機検証済みのMODを移植したもの)。
//
// - 入力注入経路はth10/th12/th128と同じDirectInput GetDeviceState(PressKey、DIKコード)。
//   MODログのFpsMonitorでGetDeviceStateが60Hzで呼ばれることを確認済み(reports/100)。
// - メインメニューの「Extra Start」は未解放だとカーソルが飛ばすため、ReplayへはDown x3で
//   着地する。スコアファイル(scoreth13.dat)の無いまっさらな状態を前提にしているので、
//   **Extraを解放したスコアファイルをタイトル資産に入れないこと**(worker/docs/titles/th13.md)。
// - 起動直後のロード中画面をタイトル画面と取り違えないよう、入力開始まで10秒待つ。
// - リプレイは"th13_ud0000.rpy"として%APPDATA%/ShanghaiAlice/th13/replay/に置かれている
//   前提(record_th13.pyのcanonical_slotとuses_appdata_profile)。

#include "autoplay/title_main.h"
#include "present/capture/d3d9_readback.h"
#include "present/limiter.h"
#include "texture/d3dx_filter.h"

using namespace autoplay;

namespace {

const MenuStep kMenu[] = {
    {.key = Key::kDown, .repeat = 3, .waitMs = 250, .label = "Down x3 (select 'Replay' on main menu)"},
    {.key = Key::kReturn, .waitMs = 700, .label = "Enter (confirm 'Replay', enter replay list)"},
    {.key = Key::kRight, .waitMs = 500, .label = "Right (switch to user replay tab)"},
    {.key = Key::kReturn, .waitMs = 700, .label = "Enter (select 1st user replay file)"},
    {.key = Key::kReturn, .waitMs = 700, .label = "Enter (confirm playback, start replay)"},
};

const TitleSpec kSpec = {
    .name = "th13",
    // 起動直後のロード中画面をタイトル画面と取り違えないよう、入力開始まで10秒待つ。
    .titleWaitMs = 10000,
    .menu = kMenu,
    // D3DXLoadSurfaceFromMemoryの縮小フィルタ補完(文字のジャギー対策、touhou-recorder
    // reports/101・102)。既定で有効(D3DX_AREA_FILTER=0で無効)。
    .textFilter = InstallD3DXFilterHook,
    .installFrameSync = InstallFrameSyncD3D9,
    .frameSyncStepDiv = 1024,
    // VsyncPatchを使わないので、等倍でもPresentを60fpsに制限する(th10・th128と同じ。
    // FPS_LIMIT_TARGET_HZがあればそちらを優先する)。
    .installLimiter = InstallFpsLimiterHook,
    // リプレイずれ判定用のスコア等サンプリング(Issue #103)。RVAはthprac
    // (thprac_th13.cpp)の絶対VAからimage base(0x400000)を引いたもの:
    //   score: 0x4be7c0 (+0x00、内部値=表示値の1/10)
    //   stage: 0x4be81c (+0x5c、1始まり。Extraは7)
    //   lives: 0x4be7f4 (+0x34)
    //   graze: 0x4be7d0 (+0x10)
    // 通常(Hard全クリア)・Extraのフル尺録画で記録スコアとの完全一致を確認済み(reports/100)。
    .scoreMonitor = {
        .baseRva = 0xbe7c0,
        .scoreOffset = 0x00,
        .scoreWidth = 4,
        .stageOffset = 0x5c,
        .stageWidth = 4,
        .livesOffset = 0x34,
        .livesWidth = 4,
        .grazeOffset = 0x10,
        .grazeWidth = 4,
    },
};

}  // namespace

DEFINE_TITLE(kSpec)
