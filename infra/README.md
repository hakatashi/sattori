# infra

AWS CDK（TypeScript）による Sattori のインフラ定義。2026-08のeu-south-2移設に伴い、
**2スタック構成**になっている。

- **`SattoriStack`**（`lib/sattori-stack.ts`、**eu-south-2**固定）: 録画基盤・API・
  DynamoDB・VPC・Web配信など、ほぼ全てのリソース。
- **`SattoriEdgeStack`**（`lib/sattori-edge-stack.ts`、**us-east-1**固定）: ACM証明書
  （CloudFrontにアタッチする証明書はus-east-1必須）とSES（eu-south-2には存在しない
  ため、2026-08-03時点確認）だけを持つ小さな付帯スタック。`SattoriStack`は
  `crossRegionReferences`経由でこの証明書ARNを受け取り、Lambda側は`SES_REGION`
  環境変数でこのリージョンのSESを明示して呼ぶ（`apps/api/src/ses.ts`）。

両スタックは`bin/sattori.ts`から起こし、`pnpm run deploy`（＝`cdk deploy --all`）で
まとめてデプロイする。単体でどちらかだけをデプロイしたい場合は
`cdk deploy SattoriEdgeStack` / `cdk deploy SattoriStack` のようにスタックIDを指定する。

## リソース一覧

- **S3**: アップロード用バケット（`.rpy`、自動削除なし。サイズが小さく保管コストが
  無視できるため）、出力用バケット（動画+進捗スクリーンショット
  `progress/{jobId}/*.jpg`、7日で自動削除）、タイトル資産バケット
  （`titles/{game}/assets.tar.gz`、Issue #22。`worker/README.md`参照）、
  Webホスティング用バケット。
- **CloudFront**: 動画配信用（`MediaCdn`、OAC非公開）・Web配信用（`WebCdn`、
  カスタムドメイン+ACM証明書）。SPAのフォールバックはCloudFront Function
  （`WebRouting`、ビューワーリクエスト）で行い、拡張子の無いパスを`/en`配下なら
  `/en/index.html`、それ以外は`/index.html`へ書き換える。**errorResponsesによる
  一律フォールバックにはしないこと**: 全パスが日本語版HTMLに落ちてしまい、
  `/en/...`を共有した際のOGP・`<title>`・`<html lang>`を英語に出し分けられなくなる
  （クローラーはJSを実行しないため、React側の書き換えではunfurlに反映されない。
  `apps/web/README.md`「多言語対応」参照）。
  `MediaCdn`は`response-content-disposition`クエリをオリジンへ転送しキャッシュ
  キーにも含める専用の`CachePolicy`（`mediaCachePolicy`）を使う（含めないと720p/
  オリジナル解像度など異なるファイル名のリクエスト間でdispositionヘッダーの
  キャッシュが混線する。`apps/api/README.md`参照）。
- **DynamoDB**: `JobsTable`（`jobId`パーティションキー、オンデマンド課金。
  DynamoDB Streams `NEW_AND_OLD_IMAGES`を有効化し完了メール送信のトリガーに使う。
  管理画面のジョブ一覧取得用GSI`StatusCreatedAtIndex`（PK=`status`, SK=`createdAt`,
  Projection=ALL）を追加済み、Issue #51。詳細は`apps/api/README.md`「管理API」）、
  `EmailRateLimitTable`（`normalizedEmail`パーティションキーのみ・1メール1item、
  TTL属性で自動削除。`apps/api/README.md`参照）、
  `SettingsTable`（`settingKey`パーティションキーのみ・固定値1item、キルスイッチ・
  月間コストガード閾値のシングルトン設定。Issue #14。`apps/api/README.md`
  「キルスイッチ・月間コストガード」参照）。
- **SES**: `EmailIdentity`（送信元ドメインのDKIM検証、マジックリンク・完了メール
  送信用）は**`SattoriEdgeStack`（us-east-1）側**にある（eu-south-2にはSESが存在
  しないため）。DKIM用CNAMEは`cdk deploy`後にCfnOutputの値を外部DNSへ手動追加する
  必要がある。また実際にサンドボックス外へ送信するには別途AWSへ申請が必要
  （コードでは自動化できない）。`SattoriStack`側のLambda（`RequestMagicLinkFn`・
  `SendCompletionEmailFn`）は`SES_REGION`環境変数（値は`us-east-1`）で
  `SESv2Client`のリージョンを明示して呼ぶ（`apps/api/src/ses.ts`）。IAMポリシーの
  `resources`も`arn:aws:ses:${props.sesRegion}:...`とSESのリージョンに合わせている。
- **ECR**: `sattori-worker`（`maxImageCount: 2`でストレージコストを抑制。
  ワーカーイメージはタイトル数に依存しない共通部分のみで構成するため、Issue #22で
  タイトル固有アセットをS3側へ分離済み）。
- **VPC**: NATなし公開サブネット×最大6AZ（`maxAzs: 6`。実際に作られる数は
  リージョンの提供AZ数とのmin。eu-south-2は現状3AZなので3つ）+ SG（egressのみ）。
  ワーカーは外向き通信のみのためNAT不要=コスト増なしでAZを広げられる。
  us-east-1運用時代はレガシーAZ（`us-east-1e`）を`WORKER_SUBNET_IDS`の組み立て時に
  除外していたが（Issue #29。VPCの`availabilityZones`明示指定での除外は
  CloudFormationのサブネット差し替えでCIDR重複エラーになり不可だったための対応）、
  eu-south-2にはレガシーAZが無いため現在はフィルタリングを行っていない。
- **EC2 Launch Template**: ワーカー起動の基点（AMI/インスタンスタイプ/IAM/SG固定）。
  ジョブ固有のUserDataは**CDKではなく実行時にAWS SDKで**`CreateLaunchTemplateVersion`
  により上書きする（`AGENTS.md`の設計判断参照。ここでのUserDataはプレースホルダで
  実際に使われることはない）。
- **Step Functions**: `RecordingStateMachine`（Standard）。`Launch`
  （`waitForTaskToken`、60分タイムアウト）→ 失敗時 `WaitBeforeCheck`（3分）→
  `HandleFailure` → `ShouldRetry?`（`shouldRetry`なら`IncrementAttempt`して
  `Launch`へ、そうでなければ`Fail`）。`HandleFailure`自体が例外を投げても
  （DynamoDB/EC2 APIの一時的なスロットリング等）実行全体を即失敗させず、
  3回リトライ後になお失敗すれば`HandleFailureCrashed`へ倒して実行を必ず終端させる
  （孤児インスタンスが残る可能性はログに残す）。詳細は`apps/api/README.md`。
- **IAM**: ワーカーロール（ECR pull / S3 / DynamoDB / ログ送出 /
  `states:SendTask*`。`SendTask*`はリソースレベル権限に非対応のため`Resource: "*"`
  がAWS側の制約として必要）+ インスタンスプロファイル、Launch Lambdaロール
  （EC2 Fleet起動 + `iam:PassRole`）、HandleFailure Lambdaロール
  （`ec2:TerminateInstances`）、StartJob Lambdaロール（`states:StartExecution`）、
  RequestMagicLink/SendCompletionEmail Lambdaロール（`JobsTable`等の読み書き +
  `ses:SendEmail`。SESサンドボックス中は送信先IDも権限チェック対象になるため、
  Resourceはアカウント配下のSES identity全体`identity/*`に絞っている）。
- **CloudWatch Logs**: `/sattori/worker`（2週間保持）。ワーカーコンテナが
  `awslogs`ドライバで書き込む。重複フレーム診断のため失敗時も残す。
- **Lambda**（`NodejsFunction`、CJS出力。ESM出力だとAWS SDK内部の動的
  `require("node:https")`がLambda(ESM)で失敗するため）× 12: createUpload /
  parseReplay / requestMagicLink / startJob / getJob / sendCompletionEmail /
  sfn.launch / sfn.handleFailure / admin.authorizer / admin.listJobs /
  admin.getJobDetail / admin.getExecution。`sendCompletionEmail`のみHTTP APIではなく
  `JobsTable`のDynamoDB Streams（`eventName: MODIFY`・`NewImage.status: "done"`
  にフィルタ）をイベントソースとする。管理系4本（`admin.*`）は`commonEnv`を使わず、
  用途ごとの環境変数のみを個別付与する（下記「管理画面」参照）。
- ワーカーAMIはSSMの ECS 最適化 AL2023（Docker同梱）を参照。

## 管理画面（`/admin`、Issue #51）

運用調査用のジョブ一覧・詳細画面。既存のWeb配信（`WebCdn`・CloudFront Function
`WebRouting`）は拡張子の無いパスを`/index.html`へ落とすため、`/admin`配下も
**追加インフラ無し**でSPAとして配信できる。フロント側の構成は
`apps/web/README.md`「管理画面」、API側は`apps/api/README.md`「管理API」を参照。

追加したインフラはAPI Gateway側のみ:

- **Lambda Authorizer**（`admin/authorizer.ts`）: REQUEST型・simple response
  （`HttpLambdaResponseType.SIMPLE`）。`identitySource`は
  `$request.header.Authorization`のみ、`resultsCacheTtl`は5分。`corsPreflight`の
  `allowHeaders`に`authorization`を追加している（`content-type`のみだった既存設定に
  Bearerトークンを送るための拡張）。
- **認可トークン**: SSM Parameter Store（`/sattori/admin/token`、SecureString）に
  手動で置く。**SecureStringはCloudFormation/CDKでは作成できない**ため、CDK側は
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
  投入・ローテーション手順の詳細は`CLAUDE.local.md`参照。
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

## デプロイ手順

```bash
pnpm build                                                       # web の dist を作る(CDKがBucketDeploymentで配信)
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm --filter @sattori/infra exec cdk bootstrap  # 初回のみ
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm run deploy                # ルートの package.json 経由で cdk deploy を実行
```

0. （初回のみ）管理画面用トークンをSSMへ手動で作成する（上記「管理画面」参照。
   CDKでは作成できないSecureStringのため、忘れると`/admin/*`が403になり続ける。
   `--region eu-south-2`を指定すること）
1. `pnpm build`（`apps/web/dist`が無いと`BucketDeployment`はスキップされる）
2. `cdk bootstrap`（初回のみ。`SattoriEdgeStack`用にus-east-1でも必要。
   `cdk bootstrap aws://<account>/us-east-1 aws://<account>/eu-south-2`）→
   `pnpm run deploy`（`infra`の`deploy`スクリプト＝`cdk deploy --all`を呼び、
   `SattoriEdgeStack`→`SattoriStack`の順にデプロイする）
3. ワーカーイメージをECRへ push（`docker build worker/` → `docker push`。
   ECRリポジトリはeu-south-2側）
4. ACM証明書のDNS検証用CNAME・SESのDKIM用CNAMEを、`cdk deploy`完了後の
   `SattoriEdgeStack`のCfnOutputを確認して外部DNSへ手動追加する
   （`hakatashi.com`はRoute 53以外で管理しているため自動検証はできない）
5. タイトル資産（ゲーム本体+WINEPREFIX+MOD）をS3へアップロードする
   （`worker/README.md`「タイトル資産のS3アップロード手順」参照）

## CDK合成のみ行う場合

```bash
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm --filter @sattori/infra synth
```

`cdk synth`はスタックIDを省略すると両スタックとも`cdk.out`へ合成するが、標準出力への
テンプレート表示にはスタックID（`SattoriEdgeStack`または`SattoriStack`）の指定が要る。

> 注: この環境はasdfのpnpmを使う。CDKの`NodejsFunction`は**リポジトリルートから
> `esbuild`をexecする**ため、ルート`devDependencies`に`esbuild`を置いてある。
> corepackのダウンロードプロンプトが出る場合は`COREPACK_ENABLE_DOWNLOAD_PROMPT=0`
> を付ける。

## テスト

`test/`配下でスタック合成のスナップショット/アサーションテスト（vitest）。
`pnpm --filter @sattori/infra test`。
