# 0027. Lambdaのエラー・スロットルアラームは関数ごとではなくアカウント全体集計に1本ずつ張る

- **状態**: 有効
- **決定日**: 2026-08-19
- **対象**: infra
- **関連**: Issue #154、`docs/decisions/0025`（運用アラート全体の通知配線）

`makeHandler`経由の全Lambda(21本)にErrors/Throttlesを個別に張る実装（0025で導入）は
それだけで42個のCloudWatch Alarmを消費し、Free Tier（10個/月）を大幅に超過して
実費が発生していた。**関数ごとの個別アラームをやめ、`AWS/Lambda`がFunctionName
ディメンション無しで自動公開するアカウント全体集計のErrors/Throttlesメトリクスに
1本ずつ張る**方式に変更する。新しいLambdaを追加してもアラームの追加配線は不要。

## 背景

Issue #135（OPS-3）でLambdaの異常に気づく手段が無い問題を解消する際、「個別に
選ぶと足し引き漏れが起きるため、監視対象の選定自体を無くす」という理由で
`makeHandler`経由の全関数へ機械的にErrors/Throttlesアラームを張った
（0025、2026-08-16デプロイ）。結果、eu-south-2だけで44個のアラーム
（42個がこのLambda監視分）が生まれ、CloudWatch Alarmの無料枠（アカウント
全体で10個/月、$0.10/超過アラームメトリクス/月）を大きく超え、AWSから
Free Tier超過の通知が届いた（Issue #154）。

CloudWatch Alarmの課金は「アラームオブジェクトの数」ではなく「アラームが
参照するメトリクスの数」で決まる（metric mathやMetrics Insightsクエリで
まとめても、参照する個別メトリクスの数だけ課金される）。そのため、42個の
アラームを少数の複合アラームにまとめても**コストは変わらない**——
実際に監視対象のメトリクス数自体を減らす必要がある。

## 決定

- `AWS/Lambda`名前空間は、`FunctionName`ディメンションを付けた関数別メトリクスとは
  別に、**同じ`Errors`・`Throttles`という指標名でディメンション無しのアカウント
  （リージョン内）全体集計メトリクスも自動的に公開している**（AWS標準機能、
  `aws cloudwatch list-metrics --namespace AWS/Lambda --metric-name Errors`で
  ディメンション無しのエントリとして確認できる）。この集計メトリクスに
  `AnyHandlerErrorsAlarm`・`AnyHandlerThrottlesAlarm`として1本ずつ張る
  （`infra/lib/sattori-stack.ts`）。
- 個別のLambda(21本)向けの`ErrorsAlarm`/`ThrottlesAlarm`はすべて削除する。
  `allHandlerFns`配列（アラーム配線専用に集めていた）も不要になったため削除する。
- 発報時にどの関数が原因かを特定する手段はアラーム名では失われる。運用者が
  CloudWatchコンソールで関数別に確認する初動手順を
  [`docs/runbooks/ops-alerts.md`](../runbooks/ops-alerts.md)に追記した。

## 根拠

- アカウント全体集計メトリクスへの変更後、eu-south-2のLambda監視分のアラームは
  42個から2個になる。RecordingStateMachineFailedAlarm・SendCompletionEmailFailedAlarm
  と合わせてeu-south-2は4個、us-east-1のSESバウンス・苦情率アラーム2個と合わせて
  Sattori全体で6個。無料枠10個に収まり、超過分の実費（月$3.7程度、Issue #154）が
  ほぼ解消する。
- `docs/runbooks/ops-alerts.md`にある通り、Lambdaエラー・スロットルは「頻発する
  エラーは実装バグ」「スロットルは想定外の連投（濫用）」を検知することが目的で
  あり、**気づくこと自体が主目的**（`AGENTS.md`§1「1名運用」）。発報後にどの関数か
  を数分かけて特定するコストは、月$3.7超過を払い続けるより許容できる。

## 採らなかった選択肢

- **metric mathやMetrics Insightsクエリで21本のメトリクスを1個のアラームに
  まとめる**。アラームオブジェクトの数は減るが、参照するメトリクス数
  （＝課金対象、Free Tierの消費対象）は変わらないため、コスト削減にならない。
  加えてmetric math単体は参照できるメトリクス数が10個までのハード上限があり、
  21本には収まらない。
- **監視対象の関数を絞る（重要な数本だけに個別アラームを残す）**。0025時点で
  「個別に選ぶと足し引き漏れが起きる」という理由で明示的に避けた設計判断を
  再び持ち込むことになる。アカウント全体集計なら選定不要のまま無料枠に収まる
  ため、この案より優れる。
- **Lambda Insightsやサードパーティのオブザーバビリティ基盤を導入する**。
  月間最大1000回規模・1名運用の本サービスにはオーバースペックで、
  `AGENTS.md`§1の「コストとオペレーションの最小化を最優先」に反する。

## 影響範囲

- `infra/lib/sattori-stack.ts`（`AnyHandlerErrorsAlarm`・`AnyHandlerThrottlesAlarm`、
  `allHandlerFns`の削除）
- `infra/test/sattori-stack.test.ts`（アラーム本数のアサーション）
- [`docs/runbooks/ops-alerts.md`](../runbooks/ops-alerts.md)（Lambdaアラーム発報時の
  初動手順）
- 今後Lambda以外のリソース（Step Functions等）を横断監視したくなった場合も、
  まず「対象サービスがディメンション無しの集計メトリクスを公開していないか」を
  確認してから個別アラームを増やすこと。
