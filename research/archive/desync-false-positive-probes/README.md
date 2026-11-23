# desync-false-positive-probes — リプレイずれ誤検知の調査に使ったプローブ

本番で `desyncDetected=true` になった録画のうち、開発者の目視で「ずれていない」と判定されたものについて、
ゲームのメモリを外から直接読んで原因を切り分けたときのスクリプト。本番のワーカー・MOD には入れていない
（調査専用）。結果は [`docs/reports/2026-11-24-desync-false-positive-investigation.md`](../../../docs/reports/2026-11-24-desync-false-positive-investigation.md)。

## 中身

| ファイル | 役割 |
| --- | --- |
| `memwatch.py` | Wine 上のゲームプロセスの `/proc/<pid>/mem` を約0.5ms間隔で読み、指定した構造体のint32が変わるたびに記録する。`--trigger` の値になった瞬間に、書き込み可能な全メモリから `--scan` の値を探す |
| `th20_pivfix.py` | `th20.exe` の点アイテム得点計算（RVA `0xC49A7`）の32bit乗算を、thprac の「PIVオーバーフロー抑制」（`th20_piv_overflow_fix`）と同じ64bit乗算へ `/proc/<pid>/mem` 経由で書き換える |
| `run1.sh` | 本番ワーカーイメージでフレーム同期録画を1本走らせる（`verify-recording-locally` skill の手順を1本用にまとめたもの） |
| `corrections.py` | ステージ開始時にゲームがリプレイ記録のスコアで上書きした量を、MODログから測る |
| `simulate.py` | 改善案の判定ルールを既存のMODログに当て、開発者の目視判定と突き合わせる |

## 動かすための前提

- `verify-recording-locally` skill の前提（`sattori-home-worker` が停止していること等）を満たすこと。
- `memwatch.py`・`th20_pivfix.py` は root で動かす（コンテナ内のプロセスの `/proc/<pid>/mem` を読むため）。
  Wine の32bitゲームはホスト側でも同じ仮想アドレスに見えるので、RVA ＋ 実行ファイルのベースで読める。
- `run1.sh` はイメージ名に `SATTORI_ECR_REPO`（`scripts/sattori-env.sh`）を使う。
- `th20_pivfix.py` は配布資産の `th20.exe` の元のバイト列と一致したときだけ書き換える（不一致なら何もしない）。

## なぜ採用しなかったか

調査のためにゲームを外から観測・改変する道具で、本番の録画パイプラインに入れる性質のものではない。
th20 のPIV修正を本番で扱う場合は、MOD の中で（`th20_replay_autoplay`）同じ計算を実装する（レポート §5）。
