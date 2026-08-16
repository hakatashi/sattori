# 0025. 運用アラート通知は1本の宛先に統一しつつ、SNSトピック自体はリージョンごとに分ける

- **状態**: 有効
- **決定日**: 2026-08-16
- **対象**: infra / apps/api
- **関連**: Issue #133（OPS-1）・#134（OPS-2）・#135（OPS-3）、公開前監査

SESバウンス・苦情監視（OPS-1）・AWS Budgets（OPS-2）・Step Functions/Lambda監視
（OPS-3）の通知先は`hakatasiloving@gmail.com`1本に統一するが、**SNSトピックは
`SattoriEdgeStack`（us-east-1）と`SattoriStack`（eu-south-2）にそれぞれ`OpsAlertTopic`
という名前で1本ずつ作る**。「トピックも1本に共通化できるはず」と思って片方を消したり
統合しようとする前にこの記録を読むこと。

## 背景

`AGENTS.md`が既に警告しているとおりSattoriは2リージョン構成（`decisions/0001`）で、
OPS-1・OPS-2が監視する対象（SESの評判メトリクス、AWS Budgets）はus-east-1、
OPS-3が監視する対象（`RecordingStateMachine`、Lambda群）はeu-south-2に存在する。
運用は1名でSlack等の別チャンネルを持たないため、「1名運用なら通知先は1本に束ねる」
（Issue #135の提案）という方針自体は妥当だが、CloudWatch Alarmの`AlarmActions`に
指定できるSNSトピックは**アラームと同一リージョンのものに限られる**（AWS公式の
制約。クロスリージョンでは指定できない）。`crossRegionReferences`で文字列やARNを
渡すこと自体は`webCertificateArn`（`decisions/0001`）と同じ要領でできるが、
「ARNを渡せる」ことと「そのARN宛にAlarmActionを設定できる」ことは別問題である。

## 決定

- SNSトピックはリージョンごとに1本ずつ（`SattoriEdgeStack`の`OpsAlertTopic`、
  `SattoriStack`の`OpsAlertTopic`）作り、どちらも同じメールアドレスを購読する。
- 例外としてAWS Budgetsの通知だけはSNSを経由せず`SubscriptionType: EMAIL`で
  直接メールへ送る（Budgetsのサブスクライバーはメール直送にも対応しているため、
  わざわざSNSを介す理由が無い）。
- 通知先メールアドレスは`infra/bin/sattori.ts`の`OPS_ALERT_EMAIL`定数1箇所に置き、
  両スタックへpropsとして渡す。

## 根拠

- CloudWatch Alarmの`AlarmActions`が同一リージョンのSNSトピックしか受け付けない
  という制約は、この構成に限らずAWS全般に共通する仕様であり回避策が無い。
  トピックを1本にまとめようとすると、片方のリージョンのアラームだけが機能しなく
  なる（デプロイ自体はエラーにならないため気づきにくい）。
- 「1本の宛先に届く」という運用者にとっての実質的な要件は、トピックを1本にせず
  とも満たせる。

## 採らなかった選択肢

- **どちらか一方のリージョンにトピックを集約し、もう一方からはLambda経由で
  中継する**。EventBridge等でクロスリージョン転送するLambdaを追加で持つ構成は、
  月間最大1000回規模の運用コストに見合わない複雑さを持ち込む
  （`AGENTS.md`§1の「コストとオペレーションの最小化を最優先」に反する）。
- **OPS-3側もBudgetsと同様メール直送にする**。CloudWatch Alarmの通知先は
  SNSトピックのみ対応（メール直送は不可）のため選べない。

## 影響範囲

- `infra/lib/sattori-edge-stack.ts`（`OpsAlertTopic`・`SesConfigurationSet`・
  評判アラーム・`MonthlyCostBudget`）
- `infra/lib/sattori-stack.ts`（`OpsAlertTopic`・`RecordingStateMachineFailedAlarm`・
  Lambda Errors/Throttlesアラーム・`SendCompletionEmailFailedMetricFilter`）
- `infra/bin/sattori.ts`の`OPS_ALERT_EMAIL`定数
- アラーム対象を増やす・移設する場合、**新しいリソースがどちらのリージョンに
  あるかで通知の配線先が変わる**ことに注意すること。
- 運用時の初動は[`docs/runbooks/ops-alerts.md`](../runbooks/ops-alerts.md)参照。
