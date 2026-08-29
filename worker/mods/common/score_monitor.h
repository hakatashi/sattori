#pragma once
#include <windows.h>
#include <stdint.h>

// ゲーム内スコア等の定期サンプリング(touhou-recorder reports/50でth20向けに導入、
// reports/53でth06/07/08/11へ横展開)。
//
// 目的は「リプレイずれ(デシンク)が起きたかどうか」を録画後に機械的に判定できる
// ようにすること(Issue #103)。リプレイファイルには記録時の最終スコアが入っている
// (`@sattori/touhou-replay-parser`で全タイトル共通に取得できる)ため、再生終了時点の
// ゲーム内スコアがそれと一致すれば「最後までズレずに再生できた」と言い切れる。
//
// タイトルによってスコア等の状態がどこに置かれているかが大きく異なる:
//
// - th06/th11/th20: 固定RVA(モジュールベースからの相対アドレス)に構造体が
//   直接置かれている。`baseIsPointer=false`
// - th07/th08: 固定RVAにあるのは構造体そのものではなく、実行時に確保される
//   状態構造体を指す**ポインタ変数**。`baseIsPointer=true`で1段階の
//   ポインタ間接参照を行う
//
// またフィールドの型・幅もタイトルごとに異なる(th06の残機は1バイト、
// th07/th08の残機はfloat、th20のスコアは64bit、他は32bit等)ため、
// `*Width`/`*IsFloat`で明示的に指定する。
//
// スコアの単位もタイトル世代で異なる。TH10以降のエンジン(th11・th20)とth07/th08は、
// ゲーム内部が保持する値が画面表示値の1/10であるという共通の慣習がある一方、th06は
// 内部値=表示値(等倍)。**このMODは常にゲーム内部の生値をそのままログに出力する**
// (換算は行わない)。表示値換算は、タイトルごとの倍率を知っている呼び出し側
// (`worker/recording_common.py`の`GAME_SCORE_MULTIPLIERS`)の責務とする
// (倍率の想定を誤っていた場合でもMODを再ビルドせずワーカー側の1行修正で直せるように
// するため。実際th08は導入当初「等倍」と誤って推測していた)。
//
// 出力される行(intervalMs間隔、値が前回と変わったときのみ):
//
//   ScoreMonitor: score=481237400 stage=7 lives=2 graze=12345 epoch_ms=...
//
// 各タイトルのRVAの根拠:
// - th06/th07/th08/th11: thprac(https://github.com/touhouworldcup/thprac)の
//   thprac_th06.cpp / thprac_th07.cpp / thprac_th08.cpp / thprac_th11.cpp
// - th20: 同thprac_th20.cpp の rel_addrs / GlobalsSide 定義(v1.00cで検証済み)
//
// 上記5タイトルで、フル尺録画による「リプレイ再生終了時のゲーム内スコアがリプレイの
// 記録スコアと完全一致する」ことを実機検証済み(touhou-recorder
// reports/53_phase53_score_monitor_all_titles.md)。th10は別途RVAを特定し
// 同様に完全一致を確認済み(reports/57、dllmain.cppのコメント参照)。ゲームデータの
// バージョンが変われば無意味な値になりうる点には注意すること。

namespace autoplay {

struct ScoreMonitorConfig {
    // 状態構造体の基点となるRVA。0なら監視スレッド自体を起動しない
    uint32_t baseRva = 0;
    // true: (moduleBase+baseRva) にあるポインタを1回だけ読み、その指す先を
    // 構造体の基点として使う(th07/th08)。false: (moduleBase+baseRva) 自体を
    // 構造体の基点として直接使う(th06/th11/th20)
    bool baseIsPointer = false;

    // スコア(基点からのオフセット、符号なし整数として読む)
    uint32_t scoreOffset = 0;
    uint8_t scoreWidth = 4;       // 1/2/4/8バイト

    // ステージ番号(符号付き整数)。widthが0なら記録しない
    uint32_t stageOffset = 0;
    uint8_t stageWidth = 0;

    // 残機(符号付き整数、またはfloat)。widthが0なら記録しない
    uint32_t livesOffset = 0;
    uint8_t livesWidth = 0;
    bool livesIsFloat = false;

    // グレイズ(符号付き整数)。widthが0なら記録しない
    uint32_t grazeOffset = 0;
    uint8_t grazeWidth = 0;

    // サンプリング間隔
    DWORD intervalMs = 1000;
};

// 監視スレッドを起動する(baseRva が 0 なら何もしない)。
void StartScoreMonitorThread(const ScoreMonitorConfig& config);

} // namespace autoplay
