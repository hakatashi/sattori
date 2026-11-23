// th14 (東方輝針城 / Double Dealing Character, TH14, ver1.00b・非Steam版) replay auto-play MOD.
//
// th14.exeに注入し、タイトル画面のロード後に
//   Down x3 -> Enter(Replay) -> Right(ユーザーリプレイタブ) -> Enter(先頭スロット選択) -> Enter(再生)
// を自動で行う。Extraモード未解放のため「Extra Start」はスキップされ、ReplayへはDown x3になる
// (th13と同じ)。th14.exeはDINPUT8・DSOUND・d3d9をインポートし、th13/th15と同じく
// GetDeviceStateで入力を読むのでPressKey(DIKコード)で注入する(touhou-recorder reports/103)。
//
// cfg/リプレイは%APPDATA%/ShanghaiAlice/th14/から読まれる。呼び出し側(record_th14.py)は
// 投入リプレイを"th14_ud0000.rpy"へ正規化すること(ユーザーリプレイタブの先頭スロット)。
// th14.cfgのオフセット0x39が1だと起動時に解像度選択ダイアログが出て止まる(0にしておくこと)。

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
    .name = "th14",
    // 起動直後はロード中画面がタイトル画面と誤認されうるので10秒待つ(th15・th20と同じ。
    // フレーム同期は11.5秒)。この区間は配信版でカットされる(`recording/cut.py`)ので、
    // 長くても動画には残らない。
    .titleWaitMs = 10000,
    .titleWaitMsFrameSync = 11500,
    .menu = kMenu,
    .installFrameSync = InstallFrameSyncD3D9,
    .frameSyncStepDiv = 1024,
    // D3D9 Presentフックでフレームレートを60fpsに制限する(th15と同じ)。
    .installLimiter = InstallFpsLimiterHook,
    // 低速録画でfps表示が低いままになる問題の補正(th15と同じ構造、touhou-recorder
    // reports/93・103)。fpsの更新(0x2e4d0)が時刻取得関数(0x6ac20)を呼ぶ経路(戻り先
    // 0x2e4e0)だけを偽装する。0x6ac20内のQueryPerformanceCounterの戻り先は0x6ac5e。
    // 等倍・倍速録画では倍率1.0となり無効。
    .realtimeExtra = [] { InstallFpsDisplayCorrectionHookViaCaller(0x0006ac5e, 0x0002e4e0); },
    // リプレイずれ判定用のスコア等サンプリング(Issue #103)。RVAはthprac(thprac_th14.cpp)の
    // 絶対VAからimage base(0x400000)を引いたもの:
    //   score: 0x4f5830 (+0x00、内部値=表示値の1/10)
    //   graze: 0x4f5840 (+0x10)
    //   lives: 0x4f5864 (+0x34)
    //   stage: 0x4f58a4 (+0x74、1始まり。Extraは7)
    // 通常(Lunatic全クリア)・Extraのフル尺録画で記録スコアとの完全一致を確認済み
    // (touhou-recorder reports/103・110)。
    .scoreMonitor = {
        .baseRva = 0xf5830,
        .scoreOffset = 0x00,
        .scoreWidth = 4,
        .stageOffset = 0x74,
        .stageWidth = 4,
        .livesOffset = 0x34,
        .livesWidth = 4,
        .grazeOffset = 0x10,
        .grazeWidth = 4,
    },
};

}  // namespace

DEFINE_TITLE(kSpec)
