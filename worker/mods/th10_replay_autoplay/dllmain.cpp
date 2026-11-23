// th10 (東方風神録 / Mountain of Faith, TH10) replay auto-play MOD.
//
// Injects into th10.exe and, after the title screen finishes loading,
// automatically navigates: MainMenu -> Replay -> (1st replay file) ->
// (confirm playback), with no user interaction required.
//
// th10.exeはth11/th20と異なり、TH10エンジン初出のこのタイトルではまだ
// GetKeyboardState方式に切り替わっておらず、DirectInputのGetDeviceStateが
// 実際に56〜60Hzでポーリングされる(FpsMonitorログで確認、touhou-recorder
// reports/56)。そのためth06/07/08と同じPressKey(DIKスキャンコード経由)を
// 使う(InstallKeyboardStateHookは不要)。
//
// タイトル画面は「10th Project Shrine Maiden」ロゴの後に"PRESS ANY BUTTON"
// 表示が続き、Enterで消してメインメニューへ進む(th06/07/08には無いステップ)。
// 実機診断で判明した重要な点: タイトルロゴ演出中に送った入力はバッファされず
// 単純に無視され、早すぎるEnterはタイトル消しに失敗する。失敗した状態で後続の
// Down/Enterを送ると、それらが「まだ表示されているPRESS ANY BUTTON」を消す
// 動作+メインメニューの項目確定に化けてしまい、Game Start等の別ルート
// (Rank Select/Player Select)に迷い込む。6000ms待つことで安定してタイトルを
// 消せることを確認済み(touhou-recorder reports/56・59)。
//
// メインメニューは Game Start / Extra Start / Practice Start / Replay /
// Player Data / Music Room / Option / Quit の8項目が常に表示されるが、
// Extra Startはカーソル移動時に自動スキップされる(実機確認: Down x1で
// Practice Start、Down x2でReplayにカーソルが移動する)。
//
// リプレイ一覧は th06/07/08 と同じ単純な番号スロット方式で、ファイル名の
// 数字がそのままスロット番号(No.NN)になる(th11/th20の_udタブ切替は無い)。
// このMODは常に「1番目のスロット(No.01)」を選ぶ固定シーケンスのため、
// record_th10.py側でコピー先ファイル名を"th10_01.rpy"に正規化する。

#include "autoplay/title_main.h"
#include "present/capture/d3d9_readback.h"
#include "present/limiter.h"
#include "texture/d3dx_filter.h"

using namespace autoplay;

namespace {

const MenuStep kMenu[] = {
    {.key = Key::kReturn, .waitMs = 1000, .label = "Enter (dismiss 'Press Any Button' title screen)"},
    {.key = Key::kDown, .repeat = 2, .waitMs = 500,
     .label = "Down x2 (select 'Replay' on main menu, skipping locked 'Extra Start')"},
    {.key = Key::kReturn, .waitMs = 500, .label = "Enter (confirm 'Replay', enter replay list)"},
    {.key = Key::kReturn, .waitMs = 700, .label = "Enter (select 1st replay file)"},
    {.key = Key::kReturn, .waitMs = 700,
     .label = "Enter (confirm playback, start replay from Stage 1)"},
};

const TitleSpec kSpec = {
    .name = "th10",
    // 6000ms(フレーム同期は8000ms)で安定してタイトルを消せることを確認済み(上のコメント)。
    .titleWaitMs = 6000,
    .titleWaitMsFrameSync = 8000,
    .firstStep = 0,
    .menu = kMenu,
    // D3DXLoadSurfaceFromMemoryの縮小フィルタ補完(文字のジャギー対策、touhou-recorder
    // reports/101・102)。既定で有効(D3DX_AREA_FILTER=0で無効)。
    .textFilter = InstallD3DXFilterHook,
    .installFrameSync = InstallFrameSyncD3D9,
    .frameSyncStepDiv = 1024,
    // 倍速録画(reports/89)ではPresentの上限をFPS_LIMIT_TARGET_HZ(60×倍率)に合わせる
    // (touhou-recorderでは低速録画検証のフェーズ58・62から同じ構成)。**等倍では入れない**:
    // このタイトルはVsyncPatchが60fpsへのフレーム制御を担っており、present/limiterは
    // FPS_LIMIT_TARGET_HZ未設定でも60fpsで間引くため、二重の制御でゲーム進行が約3%遅れた
    // (MOD統合テストで被弾タイミングが127秒時点で4.1秒遅延、Issue #288)。
    .installLimiter = InstallFpsLimiterHook,
    .limiterOnlyWhenScaled = true,
    // リプレイずれ判定用のスコア等サンプリング(Issue #103)。RVAはthprac
    // (thprac_th10.cpp)の`enum ADDRS`および`THGuiPrac::State()`内の実書き込み
    // コードから収集した絶対VA(0x474c44=score, 0x474c70=life, 0x474c7c=stage)を、
    // 0x474c00を基点(RVA=0x74c00)としたオフセットに整理したもの。score(内部値)は
    // 画面表示値の1/10(th07/th08/th11/th20と同じ×10系列)。グレイズはth10エンジン
    // にそもそも実装が見当たらない(thprac側もTHPracParamにgrazeフィールドが無い)
    // ため計測しない。フル尺録画での記録スコアとの完全一致を実機確認済み
    // (touhou-recorder reports/57、150,277,360で一致)。
    .scoreMonitor = {
        .baseRva = 0x74c00,
        .baseIsPointer = false,
        .scoreOffset = 0x44,
        .scoreWidth = 4,
        .stageOffset = 0x7c,
        .stageWidth = 4,
        .livesOffset = 0x70,
        .livesWidth = 4,
        .intervalMs = 1000,
    },
};

}  // namespace

DEFINE_TITLE(kSpec)
