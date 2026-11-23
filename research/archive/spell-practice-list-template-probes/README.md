# spell-practice-list-template-probes — スペルプラクティス耐久リプレイの終了検知の検証スクリプト

th13・th14・th20 のスペルプラクティスで「耐久で時間切れ（スペルカード未取得）」になったリプレイは、再生が終わると
リプレイ終了メニューではなく**リプレイ一覧画面へ戻ってしまい**、背景アニメーションのため画面静止検知が成立せず
録画が上限まで止まらない。その一覧画面をテンプレート照合で捕まえられるかを、残ったサブ出力と過去の全編録画に
当てて調べたときのスクリプト。本番のワーカーには入れていない（検証専用）。結果は
[`docs/reports/2026-11-24-spell-practice-timeout-end-detection.md`](../../../docs/reports/2026-11-24-spell-practice-timeout-end-detection.md)。

## 中身

| ファイル | 役割 |
| --- | --- |
| `run.sh` | 本番ワーカーイメージでフレーム同期録画を1本走らせる（`verify-recording-locally` skill の手順を1本用にまとめたもの。終了検知されないリプレイは外側の `timeout` で打ち切る） |
| `poll.py` | 終了検知のサブ出力（`repro.pollstream.raw`）と完成済み mp4 を 160x120 グレーの配列として読む |
| `masks.py` | 照合に使う画素。th13・th14 は一覧の先頭行（リプレイの内容が出る行）を除く |
| `scan.py` | 完成済みの全編録画の全フレームとテンプレートの MAD を出す（誤検知の走査） |
| `simulate.py` | `framesync._monitor_until_end()` と同じ間隔（動画の2秒）・猶予（15秒）・連続回数（2回）でテンプレート照合を当て、いつ終了と判定されるかを出す |

## 動かすための前提

- `verify-recording-locally` skill の前提（`sattori-home-worker` が停止していること、タイトル資産を複製して
  root 所有にしておくこと等）を満たすこと。`run.sh` はイメージ名に `SATTORI_ECR_REPO`（`scripts/sattori-env.sh`）を使う。
- テンプレート画像（ゲーム画面）はリポジトリに入れない（`worker/assets/` と同じ扱い）。検証時のものは
  自宅ワーカー機の `/mnt/cache3/sattori-spellprac-timeout-verify/templates/` にある。
- Python は `-I` で動かす（`numpy`・`Pillow`・`ffmpeg` が要る）。

## なぜ採用しなかったか

検証用の道具で、本番に入れるのはテンプレート照合の仕組みそのもの（`recording/framesync.py`・`recording/pipeline.py`）の
方である。採用する場合の実装方針はレポート §5 を参照。
