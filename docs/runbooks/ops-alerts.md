# 運用アラートの初動対応

`hakatasiloving@gmail.com`宛に届く運用アラート（Issue #133 OPS-1・#134 OPS-2・
#135 OPS-3）が来たときに何を見て何を止めるかをまとめる。アラームの実装・SNS
トピック構成は[`decisions/0025`](../decisions/0025-ops-alerts-per-region-sns-topics.md)、
LambdaアラームをFree Tierに収めるための集計方式は
[`decisions/0027`](../decisions/0027-lambda-alarms-account-wide-not-per-function.md)。

## SESバウンス率・苦情率アラーム（`SesBounceRateAlarm`・`SesComplaintRateAlarm`）

**バウンス率2%または苦情率0.05%を超えたら発報する**（AWSの送信一時停止ラインは
バウンス10%・苦情0.5%なので、まだ余裕がある段階で気づける設計）。

1. まずキルスイッチ（`/admin/settings`の`acceptingNewJobs`）で新規のマジックリンク
   送信を止める。バウンス・苦情の原因が無効なアドレスの大量投入（濫用）であれ
   健全なユーザーの一時的な集中であれ、**これ以上増やさないことが最優先**。
2. AWSコンソールのSES（us-east-1）→「評判」ダッシュボードで直近のバウンス内訳
   （ハード/ソフト）を確認する。ハードバウンスが急増していれば、無効アドレスへの
   連投（濫用、または`requestMagicLink.ts`の入口検証をすり抜けた不正な使い方）を
   疑う。
3. 原因が特定の送信パターンに起因する場合（例: 特定のドメイン宛が軒並み
   バウンスしている）、そのドメインへの送信を一時的に止める運用判断も検討する
   （現状これを自動化する仕組みは無い）。
4. 落ち着いたらキルスイッチを解除する。

**やってはいけないこと**: アラームを無視して受付を続けること。SESは
バウンス率10%・苦情率0.5%を超えると**アカウント全体の送信を一時停止**する。
マジックリンクが送れなくなると、jobIdがメールでしか通知されない設計
（[`decisions/0004`](../decisions/0004-job-id-as-authorization-secret.md)）上、
**代替の認証導線が無くサービスが完全停止する**。

### バウンス・苦情イベントの個別通知（上記アラームとは別物）

ConfigurationSetがBOUNCE・COMPLAINT・REJECTを同じSNSトピックへ流している
（`infra/lib/sattori-edge-stack.ts`の`addEventDestination`）ため、**1件バウンスする
たびにイベントのJSONがそのまま届く**。これはアラームではなく生のイベントであり、
上記の初動（キルスイッチ）に進む前に**まず率を見ること**。

```bash
AWS_REGION=us-east-1 aws cloudwatch get-metric-statistics --namespace AWS/SES \
  --metric-name Bounce --start-time <当日00:00Z> --end-time <現在> --period 86400 --statistics Sum
```

`Send`・`Delivery`・`Complaint`も同様に取れる。**打ち間違いによる無効アドレス1件の
ハードバウンスは日常的に起きる**（ユーザー自身が正しいアドレスで入れ直して完了している
ことが多いので、同じ人物からの後続ジョブが`done`になっていないかも見る）。率が閾値から
離れていて、同一アドレスやドメインへの連投でもなければ静観でよい。

## AWS Budgets（`MonthlyCostBudget`）

月次コスト予算80 USDに対し、実績50%/80%/100%・予測120%の4段階でメール通知が来る
（Budgets側の設定のみで、SNSトピックは経由しない）。

1. 管理画面の「コスト」ページ（`/admin/costs`）で当月の推定コスト内訳を確認する。
   ただし**この推定値は請求額そのものではない**
   （`packages/shared/src/cost.ts`、`AGENTS.md`§3・`docs/known-limitations.md`§7）
   ため、AWS Billing側の実績とは必ずしも一致しない。
2. 想定より早いペースで積み上がっている場合、キルスイッチまたは`/admin/settings`
   の月間コストガード閾値（既定50 USD）を下げて新規受付を絞る。
3. 100%（80 USD）を超える通知が来た場合は、原因調査を優先しキルスイッチで
   一旦止めることを検討する。

## RecordingStateMachine実行失敗アラーム（`RecordingStateMachineFailedAlarm`）

**1時間で3件以上の実行失敗**で発報する（単発の失敗はStep Functions自身の
リトライ機構で吸収されるため、まとまった失敗だけを拾う設定）。

1. **失敗した実行の`cause`を読む**。管理画面のジョブ一覧（`status: failed`で絞り込み、
   `/admin/jobs/{jobId}`→実行詳細）でも見られるが、`awscli`用IAMユーザーは
   Step Functionsの参照系API（`ListExecutions`・`DescribeExecution`・
   `GetExecutionHistory`）を叩けるのでCLIの方が速い。

   ```bash
   export AWS_REGION=eu-south-2
   SM=$(aws stepfunctions list-state-machines --query 'stateMachines[0].stateMachineArn' --output text)
   aws stepfunctions list-executions --state-machine-arn "$SM" --status-filter FAILED --max-items 10
   aws stepfunctions get-execution-history --execution-arn <失敗した実行のARN> --reverse-order \
     --query 'events[?contains(type,`Fail`)==`true`]'
   ```

2. **`cause`が`録画に失敗しました (exit_code=1)`だった場合**、ワーカーは起動しており、
   録画の品質チェックで全試行が破棄されている。`/sattori/worker`ロググループの
   **ログストリーム名＝jobId**（Step Functionsのリトライ分もすべて同じストリームに入る）で
   `試行 n/3`の破棄理由を読む。**これは多くの場合インフラ障害ではなく、そのリプレイが
   こちらのゲームバイナリで正常再生されないケース**である（#158）。
   - **同時間帯に同じタイトルの成功ジョブがあるか**を管理画面かジョブテーブルで確認する。
     あればリプレイ固有と切り分けてよく、サービス側の対応は不要。
   - 出力バケットの`progress/{jobId}/*.jpg`に録画中のスクリーンショットが残っており、
     **画面が何を映して止まったのかを直接確認できる**（ポーズメニューが出ていればデシンク）。
     ただし録画が25秒程度で打ち切られた場合は1枚も残らない（#159）。
3. 同一の失敗パターンが**タイトルを問わず**連続している場合はインフラ側を疑う。特に
   **ハートビートを送らない古いワーカーイメージがECRに残っている**場合、全ジョブが15分で
   タイムアウトする（`infra/README.md`「Step Functions」、`deploy-sattori` skillの警告）。
   直近でワーカーイメージのデプロイを行っていないか確認すること。
4. EC2側の起動失敗（Spotキャパシティ枯渇等）が疑われる場合は、`docs/research/`の
   リージョン別Spot状況やEC2 Fleetの候補インスタンスタイプ分散
   （[`decisions/0016`](../decisions/0016-ec2-fleet-instance-type-diversification.md)）
   を見直す。

## Lambdaエラー・スロットルアラーム（`AnyHandlerErrorsAlarm`・`AnyHandlerThrottlesAlarm`）

**5分でエラーまたはスロットルが1件以上**で発報する。CloudWatch AlarmのFree Tier
（10個/月）を超えないよう、関数ごとの個別アラームではなく`AWS/Lambda`が
FunctionNameディメンション無しで自動公開する**アカウント全体集計**の
Errors/Throttlesに1本ずつ張ってある（Issue #154、`docs/decisions/0027`）。
**メールの件名/アラーム名からは発報元の関数が分からない**ので、次のいずれかで
特定すること。

1. AWSコンソール → CloudWatch（eu-south-2）→「Lambda」の関数別ダッシュボードで、
   直近5分にErrors/Throttlesが立っている関数を探す。
2. Lambdaコンソールの各関数の「モニタリング」タブを、疑わしい関数（直近デプロイ
   したもの、`/admin`のジョブ失敗と時間が近いもの）から順に確認する。

- 頻発するエラーは実装のバグの可能性が高い。直近のデプロイと突き合わせる。
- スロットルは同時実行数上限に達している可能性がある。月間最大1000回規模の
  トラフィックでは通常起きないはずなので、想定外の連投（濫用）を疑う。
- CDKのBucketDeployment等の内部Lambda（`makeHandler`を通らないもの）のエラーも
  この集計に含まれる。デプロイ直後の発報はまずそちらを疑ってよい。

## 完了メール送信失敗アラーム（`SendCompletionEmailFailedAlarm`）

**1件以上**で発報する。`sendCompletionEmail.ts`はDynamoDB Streamsの後続レコード
処理を止めないため意図的に例外を握り潰す設計（`retryAttempts: 3`は発動しない）
になっており、このアラームが唯一の気づく手段。

1. `/aws/lambda/SendCompletionEmailFn`のログを`send_completion_email_failed`で
   検索し、該当`jobId`を特定する。
2. 動画自体はジョブページ（`/jobs/{jobId}`）から取得できるため緊急性は低いが、
   ユーザーが気づけないまま出力バケットの保持期限
   （`OUTPUT_RETENTION_DAYS`）を過ぎるとダウンロードできなくなる。原因が
   一時的なSESの障害であれば静観でよいが、継続的に失敗する場合は個別に
   ユーザーへ連絡するか、管理画面から再送を検討する（現状、完了メールの
   手動再送機能は無い）。

## アカウントレベルのサプレッションリスト（OPS-1 項目4、未自動化）

SESのアカウントレベルサプレッションリスト（バウンス・苦情したアドレスへの
自動送信停止）が有効かどうかは、CloudFormation/CDKで確認・設定できるリソースが
無いため**コードでは扱っていない**。AWSコンソールのSES（us-east-1）→
「サプレッションリスト」→「アカウントレベルの設定」で手動確認すること
（この確認にはこのリポジトリの`awscli`用IAMユーザーには権限が無く、
`ses:GetAccount`権限を持つ別のクレデンシャルが要る）。
