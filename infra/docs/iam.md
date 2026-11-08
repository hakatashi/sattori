# IAM ロール

`SattoriStack` が作る IAM ロールごとの権限と、`Resource: "*"` が要る理由の参照仕様。
Lambda やワーカーに権限を足す・絞るときに読むこと。[`infra/README.md`](../README.md)
「リソース一覧」の IAM の項から分けた。

- **IAM**: ワーカーロール（ECR pull / S3 / DynamoDB / ログ送出 /
  `states:SendTask*`。`SendTask*`はリソースレベル権限に非対応のため`Resource: "*"`
  がAWS側の制約として必要）+ インスタンスプロファイル、Launch Lambdaロール
  （EC2 Fleet起動 + `iam:PassRole`）、HandleFailure Lambdaロール
  （`ec2:TerminateInstances`）、StartJob Lambdaロール（`states:StartExecution`）、
  RequestMagicLink/SendCompletionEmail Lambdaロール（`JobsTable`等の読み書き +
  `ses:SendEmail`。SESサンドボックス中は送信先IDも権限チェック対象になるため、
  Resourceはアカウント配下のSES identity全体`identity/*`に絞っている）、
  SweepOrphanInstances Lambdaロール（`ec2:DescribeInstances`/`ec2:TerminateInstances`
  ＋`states:DescribeExecution`＋`JobsTable`読み取り、Issue #23。GPU vCPU容量リースの
  リコンサイラ（Issue #270）も同居するため`GpuSlotsTable`の読み書き＋
  `dynamodb:TransactWriteItems`も持つ）、SweepStalledJobs
  Lambdaロール（`states:DescribeExecution`＋`JobsTable`読み書き、Issue #132）、
  AcquireGpuSlot/ReleaseGpuSlot Lambdaロール（`GpuSlotsTable`読み書き＋
  `dynamodb:TransactWriteItems`。前者のみ`JobsTable`読み書きも持つ。**EC2権限は
  一切持たない**——枠取りはDynamoDBの会計のみで完結する。Issue #270）、
  **`HomeWorkerRole`**（自宅サーバーの常駐デーモンがassumeする最小権限ロール、
  Issue #49。信頼ポリシーはアカウント内プリンシパル、`maxSessionDuration`は4時間
  ＝ジョブ1本の最長所要時間より確実に長い値。実際に誰が使えるかは、手動で作る
  IAMユーザー側の`sts:AssumeRole`ポリシーで制御する。手順は
  `home-worker/README.md`参照）、AdminGetCosts Lambdaロール（CloudFrontの実配信量
  を取得する`cloudwatch:GetMetricData`。GetMetricDataもリソースレベル権限に非対応の
  ため`Resource: "*"`が必要、Issue #163）。
