# SES と運用アラート

メール送信（SES、`SattoriEdgeStack` 側）と到達性の設定、リージョンごとの運用アラート
（SNS・CloudWatch Alarm・AWS Budgets）の参照仕様。メール送信・DNS レコード・アラームを
変えるときに読むこと。[`infra/README.md`](../README.md)「リソース一覧」の SES・運用アラートの項から分けた。

- **SES**: `EmailIdentity`（送信元ドメインのDKIM検証、マジックリンク・完了メール
  送信用）は**`SattoriEdgeStack`（us-east-1）側**にある（eu-south-2にはSESが存在
  しないため）。DKIM用CNAME・MAIL FROMドメイン用MX/TXT（下記、Issue #139 UX-5）は
  `cdk deploy`後にCfnOutputの値を外部DNSへ手動追加する必要がある。また実際に
  サンドボックス外へ送信するには別途AWSへ申請が必要（コードでは自動化できない）。
  `SattoriStack`側のLambda（`RequestMagicLinkFn`・`SendCompletionEmailFn`）は
  `SES_REGION`環境変数（値は`us-east-1`）で`SESv2Client`のリージョンを明示して呼ぶ
  （`apps/api/src/ses.ts`）。IAMポリシーの`resources`も
  `arn:aws:ses:${props.sesRegion}:...`とSESのリージョンに合わせている。
  `SattoriEdgeStack`は加えて`ConfigurationSet`（`reputationMetrics: true`）を持ち、
  バウンス・苦情・拒否イベントを`OpsAlertTopic`（SNS、下記）へ流す。両Lambdaは
  送信時に`ConfigurationSetName`（`SES_CONFIGURATION_SET`環境変数、
  `crossRegionReferences`経由で`SattoriEdgeStack`から受け取る）を指定する
  （Issue #133 OPS-1）。
  - **到達性（Issue #139 UX-5）**: `EmailIdentity`に`mailFromDomain`
    （`mail.<webDomainName>`）を設定し、SPFを送信元ドメインとアラインさせている
    （カスタムMAIL FROMのMX・TXTレコードが必要。`SesMailFromMxRecord`・
    `SesMailFromSpfRecord`としてCfnOutputに出る）。加えてDMARCレコード
    （`_dmarc.<webDomainName>`）はCDKでは作れないため**手動でのみ**追加する
    （[`infra/README.md`](../README.md)「デプロイ手順」4）。送信元アドレスは`Sattori <no-reply@<webDomainName>>`
    という表示名付き形式（`infra/lib/sattori-stack.ts`の`sesFromAddress`）、
    `Reply-To`には`opsAlertEmail`と同じ問い合わせ先アドレスを載せる
    （`SES_REPLY_TO_ADDRESS`環境変数）。
- **運用アラート（OPS-1/OPS-2/OPS-3、Issue #133・#134・#135）**: SNSトピック
  `OpsAlertTopic`を**リージョンごとに1本ずつ**持つ（`SattoriEdgeStack`・
  `SattoriStack`双方）。CloudWatch Alarmは同一リージョンのSNSトピックしか
  `AlarmActions`に指定できないための分割で、どちらも同じメールアドレス
  （`bin/sattori.ts`の`OPS_ALERT_EMAIL`定数）を購読する（理由の詳細は
  [`docs/decisions/0025`](../../docs/decisions/0025-ops-alerts-per-region-sns-topics.md)）。
  - `SattoriEdgeStack`（us-east-1）: SESアカウント全体のバウンス率・苦情率
    アラーム（`AWS/SES`名前空間の`Reputation.BounceRate`≧2%・
    `Reputation.ComplaintRate`≧0.05%、AWSの送信停止ラインより十分手前）、
    月次コストのAWS Budgets（`MonthlyCostBudget`、80 USD予算に対し実績
    50%/80%/100%＋予測120%の4通知。Budgets自体はメールへ直接通知するため
    `OpsAlertTopic`は経由しない）。
  - `SattoriStack`（eu-south-2）: `RecordingStateMachine`の実行失敗
    （`ExecutionsFailed`、1時間で3件以上）、Lambdaの`Errors`/`Throttles`
    （5分で1件以上。関数ごとではなく`AWS/Lambda`のFunctionNameディメンション
    無しアカウント全体集計に1本ずつ。CloudWatch AlarmのFree Tierに収めるため、
    詳細は[`docs/decisions/0027`](../../docs/decisions/0027-lambda-alarms-account-wide-not-per-function.md)）、
    `SendCompletionEmailFn`のログに対するメトリクスフィルタ
    （`send_completion_email_failed`、1件以上。同Lambdaは後続のDynamoDB
    Streamsレコード処理を止めないよう例外を握り潰す設計のため、これが
    唯一の気づく手段）。
  - アラーム受信時の初動は[`docs/runbooks/ops-alerts.md`](../../docs/runbooks/ops-alerts.md)。
