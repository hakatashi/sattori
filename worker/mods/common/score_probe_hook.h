#pragma once
#include <windows.h>
#include <stdint.h>

// スコア変数のRVAを実測で特定するための診断フック(Issue #103)。
// touhou-recorder reports/53からの移植。
//
// touhou-recorder側で実機検証済みのth07 GAME_MANAGER RVAは、Sattoriが実際に
// 使っているth07.exe(ver 1.00b、touhou-recorderのth07.exeはver 1.00で
// バイナリが異なる)では常にNULLポインタを指しており使えないことが判明した。
// stage_probe_hookの差分スキャンは「低頻度・小さい値」のステージ番号向けに
// チューニングされておりスコアには使えないため、専用の単純なプローブを使う。
//
// 手法: 指定した固定RVA範囲(モジュールイメージ内、デフォルトはth07の既知の
// ステージ番号RVA 0x0022583c 付近)を一定間隔でDWORD単位スキャンし、
// 「単調非減少で、少なくとも1回は変化した」アドレスだけを追跡する。
// 一定回数のサンプル後、候補(最終値が指定レンジ内)をログ出力する。
//
// 環境変数:
//   SCORE_PROBE=1                 有効化(未設定なら何もしない)
//   SCORE_PROBE_RVA_START=<hex>   スキャン開始RVA。既定0x00200000
//   SCORE_PROBE_RVA_END=<hex>     スキャン終了RVA。既定0x00240000
//   SCORE_PROBE_INTERVAL_MS=<int> サンプリング間隔。既定500
//   SCORE_PROBE_SAMPLES=<int>     何サンプルで候補を出力するか。既定40
//   SCORE_PROBE_MIN_VALUE=<int>   候補とみなす最終値の下限。既定1000
//   SCORE_PROBE_MAX_VALUE=<int>   候補とみなす最終値の上限。既定100000000
//
// 本番ビルド(build.bat)には含めない。用済みになり次第削除する。

namespace autoplay {

void InstallScoreProbeHook();

} // namespace autoplay
