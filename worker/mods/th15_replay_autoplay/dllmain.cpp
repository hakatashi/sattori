// th15 (東方紺珠伝 / Legacy of Lunatic Kingdom, TH15) replay auto-play MOD.
//
// Injects into th15.exe and, after the title screen finishes loading,
// automatically navigates: MainMenu -> Replay -> (user replay tab) ->
// (1st user replay file) -> (confirm playback), with no user interaction
// required.
//
// th15は960p相当の内部描画解像度(1280x960ウィンドウ)を持つth20と同世代の
// エンジンだが、**入力ポーリング方式はth11/th20のGetKeyboardStateではなく
// th06/07/08/10と同じDirectInputのGetDeviceStateである**ことを実機検証で確認した
// (touhou-recorder reports/82)。「TH10以降のエンジンはGetKeyboardState」という
// 既存の経験則(th20導入時のコメント)はth15には当てはまらないため、PressVKeyでは
// なくth10と同じPressKey(DIKスキャンコード経由)を使う。
//
// メニュー操作シーケンスはth20と同じ構造(Replay選択 -> ユーザー枠タブへRight ->
// 1件目を選択 -> 再生確定)だが、th15はExtra Startが常にグレーアウトしている
// (未クリア救済措置が無い)ため、Down x2でReplayへ到達する(th20はDown x3)。
//
// リプレイ一覧はth11/th20と同じ_udタブ方式で、ファイル名の数字サフィックスが
// スロットを決める(th15_ud0000.rpy -> スロット"No.0000")ため、呼び出し側
// (record_th15.py)は投入リプレイをこの名前へ正規化すること。

#include "autoplay/title_main.h"
#include "clock/fps_display.h"
#include "present/capture/d3d9_readback.h"
#include "present/limiter.h"

using namespace autoplay;

namespace {

const MenuStep kMenu[] = {
    {.key = Key::kDown, .repeat = 2, .waitMs = 250,
     .label = "Down x2 (select 'Replay' on main menu, skipping grayed-out 'Extra Start')"},
    {.key = Key::kReturn, .waitMs = 700, .label = "Enter (confirm 'Replay', enter replay list)"},
    {.key = Key::kRight, .waitMs = 500, .label = "Right (switch to user replay tab)"},
    {.key = Key::kReturn, .waitMs = 700, .label = "Enter (select 1st user replay file)"},
    {.key = Key::kReturn, .waitMs = 700, .label = "Enter (confirm playback, start replay from Stage 1)"},
};

const TitleSpec kSpec = {
    .name = "th15",
    // th20と同じ10秒(フレーム同期は11.5秒)。短くした5秒では1/3倍速の`c7i.4xlarge`で
    // メニュー操作を取りこぼした(Issue #316)。この区間は配信版でカットされる(`recording/cut.py`)ので、
    // 長くても動画には残らない。
    .titleWaitMs = 10000,
    .titleWaitMsFrameSync = 11500,
    .menu = kMenu,
    .installFrameSync = InstallFrameSyncD3D9,
    .frameSyncStepDiv = 1024,
    // D3D9 Presentフックでフレームレートを制限する(th20と同じ経路、touhou-recorder reports/82で動作確認済み)。
    .installLimiter = InstallFpsLimiterHook,
    // 低速録画でfps表示が低いままになる問題の補正(touhou-recorder reports/93)。FPSInfの
    // 更新(0x335f0)が時刻取得関数(0x72c90)を呼ぶ経路だけを偽装する。0x72c90はフレーム
    // ペーシング等と共有なのでQPCの戻り先だけでは絞り込めない。等倍・倍速録画では倍率
    // 1.0となり無効。
    .realtimeExtra = [] { InstallFpsDisplayCorrectionHookViaCaller(0x00072ccb, 0x00033600); },
    // リプレイずれ判定用のスコア等サンプリング(Issue #103)。RVAはthprac
    // (thprac_th15.cpp)のth15_patch_mainフック内の絶対アドレス書き込み
    // (0x4E740C=score/10, 0x4E7450=life, 0x4E741C=graze)から、th15.exeの
    // ImageBase(0x400000、標準)を基点にRVA化したもの
    // (touhou-recorder reports/82)。score(内部値)は画面表示値の1/10
    // (th07/th08/th10/th11/th20と同じ×10系列)。ステージ番号を保持する
    // 単純な変数はthprac_th15.cpp全体を確認した範囲では見つからなかった
    // (CalcSection()による区間IDの動的計算のみ)ため、stageWidthは未指定
    // (=監視しない)。フル尺録画でリプレイ記録スコアとの完全一致を実機
    // 検証済み(reports/82)。
    .scoreMonitor = {
        .baseRva = 0xE7400,
        .scoreOffset = 0x0C,
        .scoreWidth = 4,
        .livesOffset = 0x50,
        .livesWidth = 4,
        .grazeOffset = 0x1C,
        .grazeWidth = 4,
    },
};

}  // namespace

DEFINE_TITLE(kSpec)
