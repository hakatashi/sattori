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

> リージョン移設の経緯・SESとACMだけをus-east-1に残す判断・受け入れたトレードオフは
> [`docs/decisions/0001`](../docs/decisions/0001-region-eu-south-2-ses-us-east-1.md)。

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
  `WebCdn`には計測ビーコン（`POST /beacon`、Issue #142）用の追加ビヘイビアが1つ
  あり（`additionalBehaviors["/beacon"]`）、HTTP API（`httpApi`）へ転送する。
  他のAPIエンドポイントと違いこのパスだけCloudFrontを前段に置くのは、オリジン
  リクエストポリシー`ALL_VIEWER_AND_CLOUDFRONT_2022`経由でしか得られない
  `CloudFront-Viewer-Country`ヘッダーが必要なため。キャッシュは
  `CACHING_DISABLED`（計測イベントは1件ごとに内容が違うため）。理由の詳細は
  [`docs/decisions/0024`](../docs/decisions/0024-cookieless-analytics-beacon.md)。
- **DynamoDB**: `JobsTable`（`jobId`パーティションキー、オンデマンド課金。
  DynamoDB Streams `NEW_AND_OLD_IMAGES`を有効化し完了メール送信のトリガーに使う。
  管理画面のジョブ一覧取得用GSI`StatusCreatedAtIndex`（PK=`status`, SK=`createdAt`,
  Projection=ALL）を追加済み、Issue #51。詳細は`apps/api/docs/admin-api.md`）、
  `EmailRateLimitTable`（`normalizedEmail`パーティションキーのみ・1メール1item、
  TTL属性で自動削除。`apps/api/README.md`参照）、
  `SettingsTable`（`settingKey`パーティションキーのみ、汎用の小さな設定テーブル。
  キルスイッチ・月間コストガード閾値のシングルトン設定item（Issue #14。
  `apps/api/README.md`「キルスイッチ・月間コストガード」参照）に加え、ハッシュ化
  訪問者ID用の日次salt item（`settingKey: "analyticsSalt#YYYY-MM-DD"`、TTL 2日、
  Issue #144）も同居する。`timeToLiveAttribute: "ttl"`はsalt itemだけが使う
  （キルスイッチ設定itemは`ttl`属性を持たないため無期限）。`apps/api/README.md`
  「計測」参照）、
  `WorkersTable`（`workerId`パーティションキーのみ・TTLあり。自宅サーバー常駐
  ワーカーのハートビート置き場。Issue #49。`home-worker/README.md`参照）、
  `AnalyticsEventsTable`（PK=`eventDate`（UTC日付）・SK=`eventId`、TTL 180日。
  Cookie無しの計測ビーコン（`POST /beacon`）が書き込む生イベントログ。Issue #142。
  ユニーク訪問者数算出用にIPを日次saltでハッシュ化した`visitorHash`も持つ
  （生IPは保存しない、Issue #144）。`apps/api/README.md`「計測」参照）。
  `JobsTable`にはもう1本、自宅ワーカーへのオファー用**sparse GSI**
  `HomeWorkerOfferIndex`（PK=`homeWorkerOfferState`, SK=`homeWorkerOfferExpiresAt`）
  がある。オファー中のジョブだけがこの属性を持つ（claim・撤回時にREMOVEする）ので、
  インデックス自体が「いまオファー中のジョブ一覧」になり、自宅デーモンは
  `JobsTable`全体をScanせずにポーリングできる。
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
    （下記「デプロイ手順」4）。送信元アドレスは`Sattori <no-reply@<webDomainName>>`
    という表示名付き形式（`infra/lib/sattori-stack.ts`の`sesFromAddress`）、
    `Reply-To`には`opsAlertEmail`と同じ問い合わせ先アドレスを載せる
    （`SES_REPLY_TO_ADDRESS`環境変数）。
- **運用アラート（OPS-1/OPS-2/OPS-3、Issue #133・#134・#135）**: SNSトピック
  `OpsAlertTopic`を**リージョンごとに1本ずつ**持つ（`SattoriEdgeStack`・
  `SattoriStack`双方）。CloudWatch Alarmは同一リージョンのSNSトピックしか
  `AlarmActions`に指定できないための分割で、どちらも同じメールアドレス
  （`bin/sattori.ts`の`OPS_ALERT_EMAIL`定数）を購読する（理由の詳細は
  [`docs/decisions/0025`](../docs/decisions/0025-ops-alerts-per-region-sns-topics.md)）。
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
    詳細は[`docs/decisions/0027`](../docs/decisions/0027-lambda-alarms-account-wide-not-per-function.md)）、
    `SendCompletionEmailFn`のログに対するメトリクスフィルタ
    （`send_completion_email_failed`、1件以上。同Lambdaは後続のDynamoDB
    Streamsレコード処理を止めないよう例外を握り潰す設計のため、これが
    唯一の気づく手段）。
  - アラーム受信時の初動は[`docs/runbooks/ops-alerts.md`](../docs/runbooks/ops-alerts.md)。
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
  により上書きする（ここでのUserDataはプレースホルダで実際に使われることはない）。
  **この分離を崩さないこと** ——
  [`docs/decisions/0002`](../docs/decisions/0002-ec2-launch-at-runtime-not-iac.md)。
- **Step Functions**: `RecordingStateMachine`（Standard）。`Launch`
  （`waitForTaskToken`、150分タイムアウト+**15分のハートビートタイムアウト**）→
  失敗時 `WaitBeforeCheck`（3分）→
  `HandleFailure` → `ShouldRetry?`（`shouldRetry`なら`IncrementAttempt`して
  `Launch`へ、そうでなければ`Fail`）。`HandleFailure`自体が例外を投げても
  （DynamoDB/EC2 APIの一時的なスロットリング等）実行全体を即失敗させず、
  3回リトライ後になお失敗すれば`HandleFailureCrashed`へ倒して実行を必ず終端させる
  （孤児インスタンスが残る可能性はログに残す）。詳細は`apps/api/README.md`。
  ハートビートタイムアウト（Issue #49）はワーカーの死活監視で、コンテナが60秒ごとに
  `SendTaskHeartbeat`を送る（`worker/task_heartbeat.py`）。**主目的は自宅ワーカー**
  ——自宅マシンの停電・回線断はAWS側から一切観測できず、これが無いとジョブが
  タスクタイムアウト（150分）まで「録画中」で固まる。EC2ワーカーにとっても
  ハング時の失敗検知が150分→15分に縮まる。
  **タスクタイムアウトが150分なのは低速録画（Issue #68）に合わせているため**。
  録画自体のタイムアウト（`worker/recording/pipeline.py`の`TIMEOUT_SEC`）は等倍で60分だが、
  低速録画ではゲーム進行が半分の速度になるぶん同じ比率で伸びて120分になる。これは
  ジョブごとに変えられないフェイルセーフなので、最も長くなるケースに合わせて
  120 + 30（変換・アップロードの余裕）= 150分にしてある。等倍のジョブがこれで不利に
  なることはない——実際の死活監視はハートビート（15分）が担っており、ワーカーが
  黙ればそちらが先に発火する。自宅デーモンの`HOME_WORKER_DRAIN_TIMEOUT_SEC`も
  同じ150分に揃えてある（`home-worker/README.md`）。**ハートビートを送らない古いワーカー
  イメージがECRに残っていると全ジョブが15分でタイムアウトするため、
  ワーカーイメージのpushを`cdk deploy`より先に行うこと**（下記デプロイ手順）。
- **IAM**: ワーカーロール（ECR pull / S3 / DynamoDB / ログ送出 /
  `states:SendTask*`。`SendTask*`はリソースレベル権限に非対応のため`Resource: "*"`
  がAWS側の制約として必要）+ インスタンスプロファイル、Launch Lambdaロール
  （EC2 Fleet起動 + `iam:PassRole`）、HandleFailure Lambdaロール
  （`ec2:TerminateInstances`）、StartJob Lambdaロール（`states:StartExecution`）、
  RequestMagicLink/SendCompletionEmail Lambdaロール（`JobsTable`等の読み書き +
  `ses:SendEmail`。SESサンドボックス中は送信先IDも権限チェック対象になるため、
  Resourceはアカウント配下のSES identity全体`identity/*`に絞っている）、
  SweepOrphanInstances Lambdaロール（`ec2:DescribeInstances`/`ec2:TerminateInstances`
  ＋`states:DescribeExecution`＋`JobsTable`読み取り、Issue #23）、SweepStalledJobs
  Lambdaロール（`states:DescribeExecution`＋`JobsTable`読み書き、Issue #132）、
  **`HomeWorkerRole`**（自宅サーバーの常駐デーモンがassumeする最小権限ロール、
  Issue #49。信頼ポリシーはアカウント内プリンシパル、`maxSessionDuration`は4時間
  ＝ジョブ1本の最長所要時間より確実に長い値。実際に誰が使えるかは、手動で作る
  IAMユーザー側の`sts:AssumeRole`ポリシーで制御する。手順は
  `home-worker/README.md`参照）、AdminGetCosts Lambdaロール（CloudFrontの実配信量
  を取得する`cloudwatch:GetMetricData`。GetMetricDataもリソースレベル権限に非対応の
  ため`Resource: "*"`が必要、Issue #163）。
- **EventBridge**: `OrphanInstanceSweepRule`（`ORPHAN_SWEEP_INTERVAL_MINUTES`＝10分
  間隔で`SweepOrphanInstancesFn`と`SweepStalledJobsFn`の2つを起動）。前者（Issue #23）
  は孤児化した録画EC2の定期掃除で、**ジョブレコードではなくAWS上に実在するインスタンス
  （タグ`sattori:jobId`）を起点に走査する**のが要点。`Launch`が`instanceId`をDynamoDB
  へ書く前に死んだ場合、ジョブ側からは辿れないインスタンスが残って課金だけが続くため、
  ジョブ起点の後始末（`HandleFailure`・管理画面の緊急停止）では構造的に拾えない。
  判定を安全側へ倒す仕組み（15分の猶予・実行中ジョブでは最新1台を保護）は
  `apps/api/README.md`「孤児インスタンスの検知」と
  [`docs/decisions/0017`](../docs/decisions/0017-orphan-sweep-from-aws-instances.md)参照。
  後者（`SweepStalledJobsFn`、Issue #132）は逆に**ジョブレコードのstatusを起点**にし、
  非終端のまま固まったジョブを`failed`へ確定する対の掃除役。追加のRule・GSIを増やさず
  同じRuleへ相乗りしている。詳細は`apps/api/README.md`「非終端ジョブレコードの掃除」と
  [`docs/decisions/0031`](../docs/decisions/0031-stalled-job-sweep-by-status.md)参照。
- **CloudWatch Logs**: `/sattori/worker`（2週間保持）。EC2ワーカーはdockerの
  `awslogs`ドライバで、自宅ワーカーは常駐デーモンが`PutLogEvents`で
  （dockerデーモンにAWS認証情報を持たせないため）、いずれも`{jobId}`という同じ
  ストリーム名で書き込む。重複フレーム診断のため失敗時も残す。
- **Lambda**（`NodejsFunction`、CJS出力。ESM出力だとAWS SDK内部の動的
  `require("node:https")`がLambda(ESM)で失敗するため）× 23: createUpload /
  parseReplay / requestMagicLink / startJob / getJob / getWorkerAvailability /
  recordAnalyticsEvent / sendCompletionEmail / sfn.launch / sfn.handleFailure /
  sweepOrphanInstances / sweepStalledJobs（Issue #132）/ admin.authorizer /
  admin.listJobs / admin.getJobDetail / admin.getExecution / admin.getLogs /
  admin.stopJob / admin.retryJob / admin.getCosts / admin.getAnalytics（Issue #149）/
  admin.getSettings / admin.updateSettings。HTTP APIをトリガー
  としないものが3本あり、`sendCompletionEmail`は`JobsTable`のDynamoDB Streams
  （`eventName: MODIFY`・`NewImage.status: "done"`にフィルタ）、`sweepOrphanInstances`・
  `sweepStalledJobs`はどちらも同じEventBridgeのスケジュールルール（上記、Issue #23・
  #132）をイベントソースとする。管理系（`admin.*`）の大半は他のLambdaと同じ`commonEnv`を
  使う（認可はAPI Gateway側のLambda Authorizerで完結するため環境変数を絞る動機が
  無い）。`commonEnv`を使わず用途ごとの環境変数のみを個別付与するのは
  `admin.authorizer`・`admin.getLogs`・`sweepOrphanInstances`・`sweepStalledJobs`・
  `recordAnalyticsEvent`だけ（下記「管理画面」・`apps/api/README.md`「環境変数」
  「計測」参照）。
- ワーカーAMIはSSMの ECS 最適化 AL2023（Docker同梱）を参照。

## 管理画面（`/admin`、Issue #51）

運用調査用のジョブ一覧・詳細画面。既存のWeb配信（`WebCdn`・CloudFront Function
`WebRouting`）は拡張子の無いパスを`/index.html`へ落とすため、`/admin`配下も
**追加インフラ無し**でSPAとして配信できる。フロント側の構成は
[`apps/web/docs/admin-ui.md`](../apps/web/docs/admin-ui.md)、API側は
[`apps/api/docs/admin-api.md`](../apps/api/docs/admin-api.md)を参照。

追加したインフラはAPI Gateway側のみ:

- **Lambda Authorizer**（`admin/authorizer.ts`）: REQUEST型・simple response
  （`HttpLambdaResponseType.SIMPLE`）。`identitySource`は
  `$request.header.Authorization`のみ、`resultsCacheTtl`は5分。`corsPreflight`の
  `allowHeaders`に`authorization`を追加している（`content-type`のみだった既存設定に
  Bearerトークンを送るための拡張）。
- **認可トークン**: SSM Parameter Store（`/sattori/admin/token`、SecureString）に
  手動で置く（Cognito等を使わずこの方式にした理由は
  [`docs/decisions/0005`](../docs/decisions/0005-admin-auth-ssm-shared-token.md)）。
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

## デプロイ手順

> 実際に流すコマンド（ECRリポジトリURI・バケット名の解決を含む）は `deploy-sattori` skill に
> ある。ここではスタック構成上、何をどの順で行う必要があるかを説明する。

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
   ECRリポジトリはeu-south-2側）。**`Launch`のハートビートタイムアウト（Issue #49）を
   追加・変更するデプロイでは、この手順を`cdk deploy`より先に行うこと**
   ——ハートビートを送らない古いイメージが残っていると全ジョブが15分で
   タイムアウトする
4. ACM証明書のDNS検証用CNAME・SESのDKIM用CNAME・MAIL FROM用MX/TXT
   （`SesMailFromMxRecord`・`SesMailFromSpfRecord`）を、`cdk deploy`完了後の
   `SattoriEdgeStack`のCfnOutputを確認して外部DNSへ手動追加する
   （`hakatashi.com`はRoute 53以外で管理しているため自動検証はできない）。
   加えて、CDKでは作成できない**DMARCレコード**（Issue #139 UX-5、初回のみ）を
   `_dmarc.<webDomainName> TXT "v=DMARC1; p=none; rua=mailto:<opsAlertEmail>"`
   として手動で追加する。`p=none`は監視のみで拒否・隔離をしない設定（送信量が
   少ない現状で`p=quarantine`/`p=reject`にすると、正規メールの誤判定を受信者側で
   気づけないまま失う恐れがあるため）
5. タイトル資産（ゲーム本体+WINEPREFIX+MOD）をS3へアップロードする
   （`upload-title-assets` skill。アーカイブ構成は`worker/docs/title-assets.md`）
6. （自宅ワーカーを使う場合のみ）`HomeWorkerRole`をassumeするIAMユーザーを手動で
   作成し、自宅サーバーの常駐デーモンを設定する（`docs/runbooks/home-worker-setup.md`参照。
   アクセスキーはCloudFormationで作るべきではないため手動運用）

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
