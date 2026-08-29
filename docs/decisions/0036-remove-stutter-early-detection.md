# 0036. 処理落ち早期検知(stutter probe)を削除する

- **状態**: 有効
- **決定日**: 2026-08-29
- **対象**: worker
- **関連**: reports/12・13・22(touhou-recorder、導入時の根拠)、[`0014`](0014-slow-motion-scaling-across-pipeline.md)

`recording_common.py` の処理落ち早期検知(`probe_stutter()`、通称stutter probe)を削除する。
公開リリース以降の実績を調査した結果、真陽性(実際の処理落ちを捉えた例)が1件も無く、
一方で正常なリプレイでも会話イベント中に誤検知しうる構造的な欠陥を抱えていたため。

## 背景

stutter probeは録画開始5分以内、60秒毎に0.15秒間隔で10フレームを連続キャプチャし、
隣接フレーム間のMADが`STILL_MAD_THRESHOLD`(=2.0、かなり緩い閾値)を下回る割合
(`dup_fraction`)が70%以上なら「処理落ち」とみなして録画を破棄・リトライする仕組みだった
(touhou-recorder reports/12・13・22で確認された処理落ちの検知漏れ対策として導入)。

2026-08-29、th10リリース後に本番で3件のジョブが連続失敗し、調査したところ全てstutter probe
(またはこれと同種の判定である`measure_duplicate_rate`)による誤検知と判明した。公開リリース
(2026-08-22)以降の失敗ジョブ全7件を洗い出したところ、stutter probeが発火した5件
(th07×2、th10×3)は全て進捗スクリーンショット・実機再生で「リプレイが正しく再生されない
(デシンク・非再生)」ことを確認済みで、**真陽性は1件も無かった**。

さらに、`dup_fraction`は「隣接フレームが完全一致」ではなく「MADが閾値未満」で判定するため、
文字を1文字ずつ表示するだけの静的な会話シーンでも十分閾値を割り得る。会話シーンは
プレイヤーが手動でスキップするのが通常だが、記録されたリプレイの入力次第では自動再生中に
スキップされず、**デシンクしていない正常なリプレイでもこの判定に引っかかりうる**
構造的リスクがあった(近傍の`fps_monitor`ベースの検知でも会話イベント中の一時的な
異常値を誤検知していた実例があり、`recording_common.py`のFPS_RUNAWAY_HZ_THRESHOLD
まわりのコメントに記録が残っている)。

## 決定

`probe_stutter()`・`grab_frame_gray()`・`STUTTER_PROBE_SAMPLES`/`_INTERVAL_SEC`/
`_PERIOD_SEC`/`_ACTIVE_UNTIL_SEC`/`STUTTER_DUP_FRACTION_THRESHOLD`・
`attempt_recording()`内の呼び出しと`classification == "stutter"`分岐・
`_record_with_retry()`側の対応するリトライ分岐を全て削除する。

処理落ちの検知は、録画成功後に走る`measure_duplicate_rate()`(録画開始15〜45秒の
重複フレーム率チェック、閾値30%)とタイムアウト打ち切り検知(Issue #161)にのみ委ねる。
これらは「録画が完走した後」に効く既存の仕組みで、stutter probeのように録画途中で
決定論的に破棄・リトライを繰り返すことはない。

## 根拠

- **真陽性の実績が無い**: リリース以来、stutter probeが実際の処理落ちを捉えた例は
  0件(2026-08-29調査)。過去に実際に処理落ちが起きたインシデント(サーマルスロットリング、
  [`known-limitations.md`](../known-limitations.md) §4)もstutter probe経由では検知されて
  おらず、この機構がリリース後に果たした役割は「デシンクした/非再生のリプレイを処理落ちと
  誤って報告する」ことだけだった。
- **偽陽性のリスクは正常なリプレイにも及ぶ**: `STILL_MAD_THRESHOLD`ベースの判定は
  完全な無反応(dup_fraction=1.00)だけでなく、動きの乏しい会話シーン等でも成立しうる。
  デシンクに限定されないため、閾値調整では根本解決にならない。
- 削除の副作用として、デシンク由来の完全フリーズは`TIMEOUT_SEC`(60分)まで打ち切られず
  回り続け、`timedOut`警告付きで配信される(Issue #161で既に実装済みのフォールバック)。
  待ち時間・計算資源の浪費は増えるが、正常なリプレイを誤って失敗させるリスクを許容しない
  方を優先する。

## 採らなかった選択肢

- **閾値(0.7)や有効期間(300秒)を調整して残す**: 会話シーンの長さ・頻度はタイトル・
  リプレイ内容に依存し、偽陽性を確実に排除できる値が存在する保証が無い。閾値調整は
  対症療法に過ぎない。
- **検知後の即失敗化(リトライ廃止)に留める**: 真陽性が無い以上、リトライ回数を減らして
  失敗までの時間を短縮しても、正常なリプレイを誤って失敗させる根本問題は残る。

## 影響範囲

- `worker/recording_common.py`(`probe_stutter()`・`grab_frame_gray()`・
  `STUTTER_*`定数・`attempt_recording()`・`_record_with_retry()`)
- `worker/tests/test_recording_common.py`
- `worker/README.md` §2、`worker/docs/titles/th06.md`・`th08.md`・`th11.md`の
  「処理落ちの早期検知」記述
