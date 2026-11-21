#pragma once
#include <windows.h>
#include <stdint.h>

// ゲーム内スコア等の定期サンプリング(フェーズ50でth20向けに導入、フェーズ53で
// th06/07/08/11にも横展開する形で汎用化)。
//
// 目的は「リプレイずれ(デシンク)が起きたかどうか」「リプレイ再生が記録時と同じ
// 結果まで完走したか」を録画後に機械的に判定できるようにすること。リプレイ
// ファイルには記録時の最終スコアが入っている(`@sattori/touhou-replay-parser`
// で全タイトル共通に取得できる、`scripts/51_get_replay_score.mjs`参照)ため、
// 再生終了時点のゲーム内スコアがそれと一致すれば「最後までズレずに再生できた」
// と言い切れる。
//
// タイトルによってスコア等の状態がどこに置かれているかが大きく異なる:
//
// - th06/th11/th20: 固定RVA(モジュールベースからの相対アドレス)に構造体が
//   直接置かれている(th06は`.data`内の静的構造体、th11/th20はヒープ上だが
//   フェーズ49/50で「実行ごとにアドレスが変わらない固定RVA」であることが
//   実証済み)。`baseIsPointer=false`
// - th07/th08: 固定RVAにあるのは構造体そのものではなく、実行時に確保される
//   状態構造体を指す**ポインタ変数**。`baseIsPointer=true`で1段階の
//   ポインタ間接参照を行う
//
// またフィールドの型・幅もタイトルごとに異なる(th06の残機は1バイト、
// th07/th08の残機はfloat、th20のスコアは64bit、他は32bit等)ため、
// `*Width`/`*IsFloat`で明示的に指定する。
//
// スコアの単位もタイトル世代で異なる。TH10以降のエンジン(th11・th20)と
// th07は、ゲーム内部が保持する値が画面表示値の1/10であるという共通の慣習が
// ある(`@sattori/touhou-replay-parser`のscore算出ロジックで`*10`されている
// ことから判明、th20は`reports/50`で実機検証済み)。一方th06・th08は内部値=
// 表示値(等倍)。**このMODは常にゲーム内部の生値をそのままログに出力する**
// (換算は行わない)。表示値換算(=`@sattori/touhou-replay-parser`の`score`
// との比較)は、タイトルごとの倍率を知っている呼び出し側(検証スクリプト)の
// 責務とする。MOD側で換算してしまうと、フェーズ50で実機検証済みのth20の
// 既存ログ形式(生値)との後方互換性が崩れるため。
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
// いずれも実機での動作確認(値が単調増加すること、リプレイ終了時の値が
// リプレイファイルの記録スコアと一致すること)を経て初めて信頼できる。
// ゲームデータのバージョンが変わればRVAも変わりうる点に注意。

namespace autoplay {

struct ScoreMonitorConfig {
    // 状態構造体の基点となるRVA。0なら監視スレッド自体を起動しない
    uint32_t baseRva = 0;
    // true: (moduleBase+baseRva) にあるポインタを1回だけ読み、その指す先を
    // 構造体の基点として使う(th07/th08)。false: (moduleBase+baseRva) 自体を
    // 構造体の基点として直接使う(th06/th11/th20)
    bool baseIsPointer = false;

    // スコア(基点からのオフセット、符号なし整数として読む)。
    // widthが0なら記録しない(th09のようにスコアのRVAが未特定/存在しない
    // 場合向け、フェーズ68)。この場合baseResolvedのみがログ出力のゲートになる。
    uint32_t scoreOffset = 0;
    uint8_t scoreWidth = 4;       // 1/2/4/8バイト、0で無効

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
