#pragma once
#include <windows.h>
#include <stdint.h>

// ゲーム内スコア等の定期サンプリング(touhou-recorder reports/50)。
//
// 目的は「リプレイずれ(デシンク)が起きたかどうか」を録画後に機械的に判定できる
// ようにすること。リプレイファイル末尾の平文USERセクションには記録時の最終スコアが
// 入っている(例: `Score 48123740`、画面表示はこの10倍)ため、再生終了時点の
// ゲーム内スコアがそれと一致すれば「最後までズレずに再生できた」と言い切れる。
//
// スコアはヒープではなくexeの静的領域(TH20では GlobalsSide 構造体)に置かれて
// いるため、RVA直指定でポーリングできる。RVAはゲームデータのバージョン固有の
// ハードコードであり、想定外のバイナリでは無意味な値を読むだけなので、
// 呼び出し側が対象タイトル・バージョンを確認した上で指定すること。
//
// 出力される行(intervalMs間隔、値が前回と変わったときのみ):
//
//   ScoreMonitor: score=481237400 stage=7 lives=2 graze=12345 epoch_ms=...
//
// TH20のRVAはthprac(https://github.com/touhouworldcup/thprac)の
// thprac_th20.cpp の rel_addrs / GlobalsSide 定義に基づく(v1.00c で検証済み)。
//
// Sattoriではこの出力を録画パイプラインの判定には一切使っていない。thprac導入
// (reports/50)後もデシンクが疑われるジョブが出た場合に、管理画面のワーカーログ
// (Issue #58)から「どこまでスコアが伸びたか」「残機が負になったか」を後追いで
// 確認するための証跡として残している。

namespace autoplay {

struct ScoreMonitorConfig {
    // GlobalsSide.score (uint64) の RVA。0 なら監視スレッド自体を起動しない
    uint32_t scoreRva = 0;
    // GlobalsSide + 0x1f4 のステージ番号 (uint32)。0 なら記録しない
    uint32_t stageRva = 0;
    // GlobalsSide.life_stocks (int32)。0 なら記録しない
    uint32_t livesRva = 0;
    // GlobalsSide.graze (int32)。0 なら記録しない
    uint32_t grazeRva = 0;
    // サンプリング間隔
    DWORD intervalMs = 1000;
};

// 監視スレッドを起動する(scoreRva が 0 なら何もしない)。
void StartScoreMonitorThread(const ScoreMonitorConfig& config);

} // namespace autoplay
