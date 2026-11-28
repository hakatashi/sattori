// th128(妖精大戦争 ～ 東方三月精 / Fairy Wars)の自動再生MOD。
//
// メインメニュー -> Replay -> (ユーザーリプレイタブへ切替) -> (1番目選択) -> (再生確定)
// を自動操作する。th128はメインシリーズと同じ上海アリス幻樂団(ZUN)制作の外伝作品で
// (黄昏フロンティアの格闘ゲームシリーズとは別)、TH10エンジンをベースにしている
// (thprac側のthprac_th128.cppがth10用のトラッカーコールバックをそのまま再利用して
// いることから示唆され、実機検証でも入力方式が一致した)。
//
// - 入力注入経路はth10/th12と同じPressKey(DIKスキャンコード経由)。DirectInputの
//   GetDeviceStateが実際に55〜60Hzでポーリングされることを実機確認済み(FpsMonitorログ、
//   touhou-recorder reports/70)。
// - メニュー操作シーケンス自体はth11/th12と異なりDown x1のみ(th128のメインメニューは
//   Replayのカーソル位置がth11/th12よりひとつ浅い)。
//
// **thprac(record_th128.pyのthprac_exe経由でアタッチ)が無いと録画できない**:
// リプレイ選択画面で1番目のユーザーリプレイを確定するEnterの直後、GetDeviceStateの
// 呼び出しが完全に停止しゲーム本体が無限ループに入ってフリーズする既知バグがある
// (Windows実機でも再現するゲーム本体側の既知バグとユーザーから確認済み)。thpracを
// 経由して起動するだけで解消することを実機確認済み(touhou-recorder reports/70)。
// th20と同じ理由で、record_th128.pyのthprac_exe指定を外さないこと。

#include "autoplay/title_main.h"
#include "present/capture/d3d9_readback.h"
#include "present/limiter.h"
#include "texture/d3dx_filter.h"

using namespace autoplay;

namespace {

const MenuStep kMenu[] = {
    {.key = Key::kDown, .waitMs = 500, .label = "Down x1 (select 'Replay' on main menu)"},
    {.key = Key::kReturn, .waitMs = 700, .label = "Enter (confirm 'Replay', enter replay list)"},
    {.key = Key::kRight, .waitMs = 500, .label = "Right (switch to user replay tab)"},
    {.key = Key::kReturn, .waitMs = 700, .label = "Enter (select 1st user replay file)"},
    {.key = Key::kReturn, .waitMs = 700, .label = "Enter (confirm playback, start replay)"},
};

const TitleSpec kSpec = {
    .name = "th128",
    // タイトル画面表示後、最大10秒程度までキー入力を受け付けないことがある
    // (ユーザー申告、touhou-recorder reports/70)という懸念から当初8000msを取っていたが、
    // sattori本体での実機検証(docs/reports/2026-09-16-th128-title-screen-wait-reduction-verification.md)
    // で2000msでもシーケンスが安定して成功することを確認し、短縮した(フレーム同期は8000msのまま)。
    .titleWaitMs = 2000,
    .titleWaitMsFrameSync = 8000,
    .menu = kMenu,
    // D3DXLoadSurfaceFromMemoryの縮小フィルタ補完(文字のジャギー対策、touhou-recorder
    // reports/101・102)。既定で有効(D3DX_AREA_FILTER=0で無効)。
    .textFilter = InstallD3DXFilterHook,
    .installFrameSync = InstallFrameSyncD3D9,
    .frameSyncStepDiv = 1024,
    // 低速録画用フック。FPS_LIMIT_TARGET_HZ未設定時はscale=1.0で従来動作と完全互換
    // (touhou-recorder reports/72で30fps実機検証済み)。
    .installLimiter = InstallFpsLimiterHook,
    // リプレイずれ判定用のスコア等サンプリング(Issue #103)。RVAはthprac
    // (thprac_th128.cppの`th128_patch_main`フック内で練習モードの初期値を
    // ゲーム内変数へ直接書き込んでいる箇所)の絶対VA(image base 0x400000)から収集し、
    // 基点0x4b4c00(RVA=0xb4c00)からのオフセットに整理したもの。フル尺録画
    // (通常・Extra両方)で記録スコアとの完全一致を実機確認済み(touhou-recorder reports/71)。
    //   score:      +0xc4 (画面表示値の1/10、th10/th12と同じ×10系列)
    //   motivation: +0x164(「やる気」ゲージ、残機に相当。表示値は生値/100)
    // グレイズはth128エンジンに実装が見当たらない(thprac側もTHPracParamに
    // grazeフィールドが無い)ため計測しない。
    .scoreMonitor = {
        .baseRva = 0xb4c00,
        .scoreOffset = 0xc4,
        .scoreWidth = 4,
        .livesOffset = 0x164,
        .livesWidth = 4,
    },
};

}  // namespace

DEFINE_TITLE(kSpec)
