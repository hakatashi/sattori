# 管理画面（`/admin`、Issue #51）のインフラ

管理画面のために API Gateway 側へ足したインフラ（Lambda Authorizer・SSM の認可トークン・
ルート・停止/再実行 Lambda の権限）の参照仕様。管理 API のルートや権限を変える前、初回
デプロイでトークンを作る前に読むこと。[`infra/README.md`](../README.md)「管理画面」から分けた。

運用調査用のジョブ一覧・詳細画面。既存のWeb配信（`WebCdn`・CloudFront Function
`WebRouting`）は拡張子の無いパスを`/index.html`へ落とすため、`/admin`配下も
**追加インフラ無し**でSPAとして配信できる。フロント側の構成は
[`apps/web/docs/admin-ui.md`](../../apps/web/docs/admin-ui.md)、API側は
[`apps/api/docs/admin-api.md`](../../apps/api/docs/admin-api.md)を参照。

追加したインフラはAPI Gateway側のみ:

- **Lambda Authorizer**（`admin/authorizer.ts`）: REQUEST型・simple response
  （`HttpLambdaResponseType.SIMPLE`）。`identitySource`は
  `$request.header.Authorization`のみ、`resultsCacheTtl`は5分。`corsPreflight`の
  `allowHeaders`に`authorization`を追加している（`content-type`のみだった既存設定に
  Bearerトークンを送るための拡張）。
- **認可トークン**: SSM Parameter Store（`/sattori/admin/token`、SecureString）に
  手動で置く（Cognito等を使わずこの方式にした理由は
  [`docs/decisions/0005`](../../docs/decisions/0005-admin-auth-ssm-shared-token.md)）。
  **SecureStringはCloudFormation/CDKでは作成できない**ため、CDK側は
  `ssm.StringParameter.fromSecureStringParameterAttributes()`で名前を参照するのみで、
  値には一切触れない（`.stringValue`を参照するとCFnの動的参照
  `{{resolve:ssm-secure:...}}`が生成され値がテンプレートに染み出すため、`grantRead`
  （ARNのみ使用）と、`kms:ViaService`条件付きの`kms:Decrypt`個別権限のみを付与する）。
  **`cdk deploy`より前に手動でパラメータを作成すること**（無くてもデプロイ自体は
  失敗しないが、作成するまで`/admin/*`は全て403になる）:
  ```bash
  aws ssm put-parameter --region eu-south-2 --name /sattori/admin/token \
    --type SecureString --value "$(openssl rand -hex 32)" --overwrite
  ```
  投入・ローテーション手順の詳細は`deploy-sattori` skill 参照。
- **ルート**: `GET /admin/jobs`・`GET /admin/jobs/{jobId}`・
  `GET /admin/jobs/{jobId}/execution`・`GET /admin/jobs/{jobId}/logs`（Issue #58）・
  `POST /admin/jobs/{jobId}/stop`・`POST /admin/jobs/{jobId}/retry`（Issue #59）の
  6つ、いずれも上記authorizerで保護。停止・再実行は状態を変えるため`POST`にしている
  （`DELETE`を使うと`corsPreflight.allowMethods`（現状`GET`/`POST`のみ）の拡張も要る）。
- **停止・再実行Lambdaの権限**（Issue #59）: `AdminStopJobFn`には
  `stateMachine.grantExecution(fn, "states:StopExecution", "states:DescribeExecution")`
  と`ec2:TerminateInstances`・`ec2:DescribeInstances`（前者は対象インスタンスが実行時
  にしか決まらないため`handleFailureFn`と同じくResource:*、後者はそもそも
  リソースレベルの権限指定に非対応）、`AdminRetryJobFn`には`grantStartExecution`と
  `states:DescribeExecution`、`UploadBucket`の読み取り（元の`.rpy`が残っているかの
  確認用）。どちらも`jobsTable`は読み書き、`STATE_MACHINE_ARN`は`startJobFn`と同様に
  個別付与する。`DescribeExecution`が両方に要るのは、**ジョブの`status`が「実行が
  終わったか」の代理条件にならない**ため（ワーカーが`SendTaskFailure`より先に
  `failed`を書き、ステートマシンはその後もリトライを続ける。`apps/api/README.md`参照）。
  `DescribeInstances`は、`instanceId`が未記録のまま起動した孤児インスタンスを
  タグ`sattori:jobId`から回収するために使う。
