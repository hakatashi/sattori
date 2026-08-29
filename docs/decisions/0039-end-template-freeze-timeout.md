# 0039. end_template方式のタイトルにも画面フリーズの早期打ち切りを追加する

- **状態**: 有効
- **決定日**: 2026-08-30
- **対象**: worker
- **関連**: Issue #195、[`0038`](0038-remove-stutter-early-detection.md)（削除の経緯）、
  [`0011`](0011-replay-end-template-matching.md)（end_template方式そのもの）

`recording_common.py` の `attempt_recording()` に、end_template方式のタイトル専用の
画面フリーズ早期打ち切り(`FREEZE_CONSECUTIVE_REQUIRED`、5分)を追加する。stutter probe
削除([`0038`](0038-remove-stutter-early-detection.md))の副作用で生じた「デシンク等の
完全フリーズがTIMEOUT_SEC(60分)まで打ち切られない」問題を、誤検知を再導入せずに緩和する。

## 背景

[`0038`](0038-remove-stutter-early-detection.md)でstutter probeを削除した結果、完全な
フリーズ(デシンク・非再生)を早期に検知する手段が無くなった。end_template方式(th06/07/08/10)
は終了判定そのものに画面静止判定を使わないため([`0011`](0011-replay-end-template-matching.md))、
この経路では画面静止を一切見ておらず、フリーズしたジョブはTIMEOUT_SEC(60分)まで検知
されない。さらにこの種のフリーズは録画開始直後の重複フレーム率チェックにも引っかかって
「破棄してリトライ」されるため、`MAX_ATTEMPTS_DEFAULT`(既定3回)ぶん60分ずつ、最悪3時間
近く浪費する。

th11/th20(画面静止のみで終了判定するタイトル)はこの問題が起きない。フリーズすれば
`STILL_CONSECUTIVE_REQUIRED`(16秒)で「終了検知」扱いとなり、通常のタイムアウトよりずっと
早く打ち切られる(`classification` は `"good"` になる。誤って正常終了扱いになる点は
既存の挙動でありこの決定の対象外)。

## 決定

`attempt_recording()`のポーリングループで、end_templateが使えるタイトルに限り、
`STILL_MAD_THRESHOLD`ベースの連続静止判定を並行して行う。連続回数が
`FREEZE_CONSECUTIVE_REQUIRED`(=150、低速録画ではtime_scale倍。等倍で
150 * POLL_INTERVAL_SEC = 300秒 = 5分)に達したら、`frozen`フラグを立ててループを抜ける。

classificationは新設せず、既存の`"timeout"`を再利用する。`_record_with_retry()`側は
`classification == "timeout"`を「リトライせず、`JobRecord.timedOut`警告付きで配信する」
既存の分岐でそのまま処理するため、変更不要(Issue #161で実装済みのフォールバック)。

## 根拠

- **5分は会話シーン等の正常な静止より大幅に長い**。stutter probeの誤検知は「短時間
  サンプリング(0.15秒間隔・10フレーム)で瞬間的な静止を拾ってしまう」構造的欠陥が原因
  だった([`0038`](0038-remove-stutter-early-detection.md)根拠節)。本決定の判定は
  2秒間隔のポーリングで**連続150回**、途中で1回でも動きがあればカウンタがリセットされる
  ため、5分間ノンストップで完全に無変化であることを要求する。通常のリプレイ内容
  (会話イベント・スコア表示の点滅等)がこの長さ静止し続けることは想定していない。
- **既存の"timeout"分岐を再利用することで、リトライ判断ロジックへの変更を避けられる**。
  「フリーズを検知したら即失敗」ではなく「タイムアウトと同じ扱いで配信を試み、警告を
  出す」という0038の決定(「正常なリプレイを誤って失敗させるリスクを許容しない」)を
  踏襲する。本決定が変えるのは検知までの**時間**だけで、検知後の扱いは変えない。
- 3回リトライされる本当のフリーズジョブでも、1試行あたり60分→5分程度に短縮できるため、
  Issue #193/#194で問題になった「タイムアウトx3」の実害(3時間近い滞留)を大幅に減らせる。

## 採らなかった選択肢

- **stutter probeを閾値調整の上で復活させる**: [`0038`](0038-remove-stutter-early-detection.md)
  「採らなかった選択肢」で既に否定済み。短時間サンプリング方式そのものが誤検知の
  構造的原因であり、本決定のような長時間連続判定とは別物。
- **end_template方式でも画面静止を終了判定に使う**: [`0011`](0011-replay-end-template-matching.md)
  で「ステージクリア画面等の一時的な静止をリプレイ終了と誤判定する」ことが理由で
  廃止された方式に戻すことになり、根本的な後退。本決定はあくまで「終了判定」ではなく
  「異常フリーズの打ち切り」として、閾値を大幅に長くした別の判定を追加するだけに留める。
- **フリーズ検知時にリトライさせる(discardして再試行)**: 真陽性(実際のフリーズ)しか
  拾わない設計のため一見安全に見えるが、リトライしても同一リプレイなら同じ箇所で
  再現する([`worker/README.md`](../../worker/README.md) §13の既知の制約と同様)。
  無駄なリトライを増やすだけで、`"timeout"`同様「1回受理して警告配信」の方が資源効率が
  良い。

## 影響範囲

- `worker/recording_common.py`(`FREEZE_CONSECUTIVE_REQUIRED`・`attempt_recording()`の
  ポーリングループ・classification分岐)
- `worker/README.md` §2(recording_common.pyの説明)
