import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  CfnOutput,
  Duration,
  Fn,
  RemovalPolicy,
  Stack,
  type StackProps,
} from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cwActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import { NodejsFunction, type NodejsFunctionProps } from "aws-cdk-lib/aws-lambda-nodejs";
import * as apigw from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { HttpLambdaAuthorizer, HttpLambdaResponseType } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import * as tasks from "aws-cdk-lib/aws-stepfunctions-tasks";
import {
  HOME_WORKER_OFFER_INDEX,
  LAUNCH_LAMBDA_TIMEOUT_SECONDS,
  ORPHAN_SWEEP_INTERVAL_MINUTES,
  OUTPUT_RETENTION_DAYS,
} from "@sattori/shared";
import { DynamoEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import type { Construct } from "constructs";

const HERE = dirname(fileURLToPath(import.meta.url));
const API_HANDLERS = join(HERE, "../../apps/api/src/handlers");
const WEB_DIST = join(HERE, "../../apps/web/dist");

export interface SattoriStackProps extends StackProps {
  /** Web/メールで共通して使うカスタムドメイン(SattoriEdgeStackと同じ値を渡すこと)。 */
  webDomainName: string;
  /**
   * CloudFront(WebCdn)にアタッチするACM証明書のARN。CloudFront用証明書はus-east-1
   * 必須のため、このスタック(eu-south-2)では作成できず、`SattoriEdgeStack`
   * (us-east-1)が作った証明書のARNを`crossRegionReferences`経由で受け取る。
   */
  webCertificateArn: string;
  /**
   * SESクライアントが実際に呼ぶリージョン。eu-south-2にはSESが存在しないため
   * (2026-08-03時点確認)、`SattoriEdgeStack`が検証済みドメインを持つus-east-1を渡す。
   * Lambda側(apps/api/src/ses.ts)がこの値を`SES_REGION`環境変数経由で読み、
   * `SESv2Client`にリージョンを明示する。
   */
  sesRegion: string;
  /**
   * SES送信時に指定するConfigurationSet名。`SattoriEdgeStack.sesConfigurationSetName`
   * をそのまま渡す(Issue #133 OPS-1)。
   */
  sesConfigurationSetName: string;
  /**
   * 運用アラート(Step Functions失敗・Lambdaエラー等、Issue #135 OPS-3)の通知先
   * メールアドレス。`SattoriEdgeStack`側の運用アラート(Issue #133/#134)と同じ値を
   * 渡すが、SNSトピック自体はリージョンごとに分ける(`docs/decisions/0025`)。
   */
  opsAlertEmail: string;
}

/**
 * Sattori フェーズ1のインフラ一式。
 * 録画基盤(S3/CloudFront/ECR/EC2 Spot)＋ サーバーレス API(Lambda/API Gateway/DynamoDB)。
 * EC2 Spot の起動はここでは行わず、API Lambda が実行時に AWS SDK で起動する
 * (terraform-provider-aws の Spot ハング問題を避ける方針, PoC reports/16)。
 * ACM証明書とSESだけは`SattoriEdgeStack`(us-east-1固定)が持つ。理由は同スタックの
 * コメント参照。
 */
export class SattoriStack extends Stack {
  constructor(scope: Construct, id: string, props: SattoriStackProps) {
    super(scope, id, props);

    // Web/メールで共通して使うカスタムドメイン。CloudFront(WebCdn)とSES送信元アドレス
    // (no-reply@<このドメイン>)の両方で使うため、コンストラクタ先頭で定義しておく。
    const webDomainName = props.webDomainName;

    // --- ストレージ ---------------------------------------------------------

    // アップロードされた .rpy を一時保管するバケット。
    // .rpy はサイズが小さく保管コストが無視できるため、自動削除は行わない。
    const uploadBucket = new s3.Bucket(this, "UploadBucket", {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      cors: [
        {
          // ブラウザからの署名付き PUT を許可する。オリジンはフェーズ2で
          // 配信ドメインに絞る(現状は検証容易性を優先し全許可)。
          allowedMethods: [s3.HttpMethods.PUT],
          allowedOrigins: ["*"],
          allowedHeaders: ["*"],
        },
      ],
    });

    // 録画済み動画の出力バケット(OUTPUT_RETENTION_DAYS日で自動削除, CloudFront オリジン)。
    // 日数は @sattori/shared の定数と共有し、getJob.ts が返すダウンロード期限表示
    // (ジョブ画面・完了メール)とずれないようにする。
    const outputBucket = new s3.Bucket(this, "OutputBucket", {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      lifecycleRules: [
        { expiration: Duration.days(OUTPUT_RETENTION_DAYS) },
        // 720p変換のffmpeg生ログ(`worker/entrypoint.py`のFFMPEG_UPSCALE_LOG_KEY、
        // Issue #58フォローアップ)。CloudWatch Logsのノイズ対策として退避した診断用
        // データに過ぎず動画本体より価値が低いため、上記の既定ルールより短く失効させる
        // (どちらのルールもマッチするが、より早い失効が優先されるため`worker-logs/`配下は
        // 実質3日で消える)。
        { prefix: "worker-logs/", expiration: Duration.days(3) },
      ],
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // ダウンロードボタンは`response-content-disposition`クエリパラメータ付きのURLを使う
    // (apps/api/src/handlers/getJob.ts が組み立てる)。S3のGetObject APIはこのクエリを
    // そのまま`Content-Disposition`レスポンスヘッダーへエコーバックするため、ブラウザ
    // 標準のダウンロード機構(進捗表示・タブを離れても継続・ディスクへの直接
    // ストリーミング)を使わせられ、フロントエンド側のfetch+Blob化やCORS許可が不要になる
    // (旧実装からの変更点。AGENTS.md参照)。このクエリをオリジン(S3)へ転送しキャッシュキー
    // にも含めるため、標準の CACHING_OPTIMIZED ではなく専用の CachePolicy を使う
    // (含めないと同一動画への初回リクエストのdispositionがそのまま以降もキャッシュされ、
    // 720p/オリジナル解像度など異なるファイル名のリクエストに誤って使い回されてしまう)。
    const mediaCachePolicy = new cloudfront.CachePolicy(this, "MediaCachePolicy", {
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.allowList(
        "response-content-disposition",
      ),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
      minTtl: Duration.seconds(1),
      defaultTtl: Duration.days(1),
      maxTtl: Duration.days(365),
      comment: "Sattori 録画動画配信(response-content-dispositionをキャッシュキーに含める)",
    });

    // 動画配信用 CloudFront(OAC 経由の非公開配信, 無料枠でegress実質ゼロ)。
    const mediaDistribution = new cloudfront.Distribution(this, "MediaCdn", {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(outputBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: mediaCachePolicy,
      },
      comment: "Sattori 録画動画配信",
    });

    // --- ジョブ状態(DynamoDB) ----------------------------------------------

    const jobsTable = new dynamodb.Table(this, "JobsTable", {
      partitionKey: { name: "jobId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
      // 完了メール送信(SendCompletionEmailFn)がstatus:doneへの遷移を検知するために使う
      // (Issue #10)。新旧両方の値が要る(遷移の判定に旧statusが必要)ためNEW_AND_OLD_IMAGES。
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
    });

    // 管理画面(`/admin`、Issue #51)のジョブ一覧取得用GSI。PK=status, SK=createdAt。
    // status/createdAtは`putJob()`が必ず設定し、以降どの更新経路(updateJobStatus等)
    // でもSETのみで消えない既存属性のため、GSIを追加するだけで既存レコードが自動的に
    // インデックスへ載る(バックフィル不要)。Projectionは月1000ジョブ規模ではストレージ費
    // が無視できる一方、INCLUDEは後から射影属性を増やせない(GSI再作成が必要)ため、
    // 早すぎる最適化を避けALLにする。一覧取得ロジックは`apps/api/src/adminJobs.ts`参照。
    jobsTable.addGlobalSecondaryIndex({
      indexName: "StatusCreatedAtIndex",
      partitionKey: { name: "status", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "createdAt", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // 自宅ワーカー(Issue #49)がジョブを引き取るためのオファー用sparse GSI。
    // PK=homeWorkerOfferState(値は"open"の1種類のみ), SK=homeWorkerOfferExpiresAt。
    // **オファー中のジョブだけがこの属性を持つ**(claim・撤回時にREMOVEする)ため、
    // インデックス自体が「いまオファー中のジョブ一覧」になり、自宅デーモンは
    // JobsTable全体をScanせずに数msでポーリングできる。同時にオファー中のジョブは
    // 高々数件なのでProjectionはALLでよい(StatusCreatedAtIndexと同じ理由で、
    // 後から射影属性を増やせないINCLUDEを避ける)。
    jobsTable.addGlobalSecondaryIndex({
      indexName: HOME_WORKER_OFFER_INDEX,
      partitionKey: { name: "homeWorkerOfferState", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "homeWorkerOfferExpiresAt", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // 常駐ワーカー(自宅サーバー、Issue #49)のハートビート。自宅マシンは動的
    // グローバルIP・NAT配下でAWS側から到達できないため、「AWSが自宅を叩く」のでは
    // なく「自宅が自分の生存と空き状況をここに書き、ジョブを取りに来る」Pull型に
    // している。`Launch`はこのテーブルを読んで、そもそもオファーする価値があるか
    // (＝録画開始を数十秒遅らせる価値があるか)を判断する。
    // アイテムはワーカー台数ぶん(現状1件)しかない。デーモンが止まったレコードは
    // TTLで自動的に消える。
    const workersTable = new dynamodb.Table(this, "WorkersTable", {
      partitionKey: { name: "workerId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
      timeToLiveAttribute: "ttl",
    });

    // メール送信のレート制限(同一メール24時間5件まで、Issue #9)用カウンタ。
    // PK: 正規化後のメールアドレスのみ(1メール1item)。件数チェックと記録を
    // 条件付きUpdateItem1回に一本化して原子的に行うため、Query対象のログitemは
    // 持たない(apps/api/src/rateLimit.ts)。TTL属性で自動削除する。
    const emailRateLimitTable = new dynamodb.Table(this, "EmailRateLimitTable", {
      partitionKey: { name: "normalizedEmail", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
      timeToLiveAttribute: "ttl",
    });

    // キルスイッチ・月間コストガード閾値（Issue #14）のシングルトン設定を持つ小さな
    // テーブル。PKは固定値1件のみ（`apps/api/src/settings.ts`の`SETTINGS_KEY`）。
    // SSM Parameter Store（管理画面トークンで採用）ではなく専用テーブルにしたのは、
    // こちらは管理画面から頻繁に更新する運用データであり、`cdk deploy`前の手動投入が
    // 必要なSecureStringの運用（CLAUDE.local.md参照）と性質が異なるため。
    // timeToLiveAttribute はキルスイッチ設定itemには使わず(無期限)、ハッシュ化
    // 訪問者ID用の日次salt(`analyticsSalt#YYYY-MM-DD`、Issue #144、
    // `apps/api/src/analyticsSalt.ts`)だけがttl属性を持つ。同じテーブルの他item
    // には影響しない。
    const settingsTable = new dynamodb.Table(this, "SettingsTable", {
      partitionKey: { name: "settingKey", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
      timeToLiveAttribute: "ttl",
    });

    // Cookie無しのサーバーサイド計測（`POST /beacon`、Issue #142）が書き込む生イベント
    // ログ。PK=eventDate(UTC日付, YYYY-MM-DD)・SK=eventIdで、日付ごとにパーティションを
    // 分けておくと将来「直近N日を集計する」処理がQueryで済み、JobsTableのような
    // 全件Scanを要らないようにできる。TTL(180日、`apps/api/src/analytics.ts`の
    // ANALYTICS_EVENT_TTL_DAYS)で自動的に古いイベントを削除する——生イベントは
    // 集計の一次データであり無期限に貯める設計にはしていない。設計の背景は
    // `docs/decisions/0024-cookieless-analytics-beacon.md`。
    const analyticsEventsTable = new dynamodb.Table(this, "AnalyticsEventsTable", {
      partitionKey: { name: "eventDate", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "eventId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
      timeToLiveAttribute: "ttl",
    });

    // --- メール送信(SES, マジックリンク認証 Issue #9) -----------------------
    // webDomainName配下から送信する(no-reply@<webDomainName>)。ドメイン検証・DKIM・
    // EmailIdentity自体は`SattoriEdgeStack`(us-east-1、eu-south-2にはSESが存在しない
    // ため)が持つ。ここでは送信元アドレスの文字列と、SESクライアントを向けるリージョン
    // (`props.sesRegion`)だけを扱う。表示名を付けるのはIssue #139
    // UX-5（表示名なしの裸アドレスだと受信箱に「no-reply」としか出ず、迷惑メール
    // 判定・開封率の両面で不利なため）。SESv2の`FromEmailAddress`はRFC 5322形式
    // (`"表示名 <email>"`)をそのまま受け付ける。
    const sesFromAddress = `Sattori <no-reply@${webDomainName}>`;
    // 返信されても気づける問い合わせ先を`Reply-To`に載せる(Issue #139 UX-5)。
    // `AboutPage`に既に公開している連絡先と同じアドレス(`opsAlertEmail`)を流用する。
    const sesReplyToAddress = props.opsAlertEmail;

    // --- 録画ワーカー(ECR / VPC / IAM) -------------------------------------

    // ワーカーイメージはタイトル数に依存しない共通部分のみで構成する(Issue #22)ため、
    // 世代数を抑えても運用上問題ない。ECRはS3の4倍以上高い($0.10/GB/mo vs $0.023/GB/mo)
    // ため、世代数を絞ってストレージコストをさらに下げる。
    const workerRepo = new ecr.Repository(this, "WorkerRepo", {
      repositoryName: "sattori-worker",
      removalPolicy: RemovalPolicy.DESTROY,
      emptyOnDelete: true,
      lifecycleRules: [{ maxImageCount: 2 }],
    });

    // タイトル固有アセット(ゲーム本体+WINEPREFIX+MOD、`titles/{game}/assets.tar.gz`)を
    // 保管するバケット。ECRストレージコストがタイトル数に比例して増大する問題への対応
    // として、これらをワーカーイメージから分離しS3へ移した(Issue #22、S3StandardはECR
    // より4倍以上安い)。ワーカーが起動時にGAME環境変数に応じてダウンロード・展開する。
    const titleAssetsBucket = new s3.Bucket(this, "TitleAssetsBucket", {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // NAT を持たない公開サブネット構成(ワーカーは外向き通信のみ必要 = 最小コスト)。
    // maxAzs は「利用可能なら使うAZ数の上限」であり、実際に作られるサブネット数は
    // リージョンの提供AZ数とのmin(6, 提供数)になる(eu-south-2は現状3AZなので3つ)。
    // EC2 Fleet の起動時に全AZへスポットリクエストを送ることで、単一AZでの
    // キャパシティ枯渇(InsufficientInstanceCapacity)への耐性を高める(NATを
    // 使わないためAZ追加によるコスト増はない)。将来AZが増えた場合に自動的に
    // 追従してほしいため6のまま据え置く。
    //
    // かつて us-east-1 運用時は、レガシーAZ(us-east-1e)を availabilityZones の
    // 明示指定で除外する案を試みたが、既存サブネットのAZ・CIDRを差し替える形の更新に
    // なり、CloudFormationが新サブネット作成を旧サブネット削除より先に試みるため
    // CIDR重複でデプロイが失敗した(create-before-deleteの既定挙動とCIDR一意制約が
    // 噛み合わない, Issue #29)。WORKER_SUBNET_IDS の組み立て時に該当AZを除外する
    // ことで同じ目的を安全に達成していたが、eu-south-2への移設でそのレガシーAZ問題
    // 自体が解消したため、現在はフィルタリングを行っていない(下記参照)。
    const vpc = new ec2.Vpc(this, "WorkerVpc", {
      maxAzs: 6,
      natGateways: 0,
      subnetConfiguration: [
        { name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
      ],
    });

    const workerSg = new ec2.SecurityGroup(this, "WorkerSg", {
      vpc,
      description: "Sattori recording worker (egress only)",
      allowAllOutbound: true,
    });

    // ワーカーコンテナのログ(entrypoint・録画・ffmpeg進捗)を集約する
    // CloudWatch Logs ロググループ。docker の awslogs ドライバが書き込む。
    // 録画の重複フレーム(処理落ち)診断に使うため、失敗時も残るよう EC2 側で送出する。
    const workerLogGroup = new logs.LogGroup(this, "WorkerLogGroup", {
      logGroupName: "/sattori/worker",
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // ワーカー EC2 に付与するロール。ECR pull・リプレイ取得・動画出力・状態更新・ログ送出。
    const workerRole = new iam.Role(this, "WorkerRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
    });
    uploadBucket.grantRead(workerRole);
    // 書き込み(録画・進捗スクリーンショットのアップロード)に加え、変換フェーズ再開時に
    // 生動画チェックポイントを読み戻すため読み取りも必要。
    outputBucket.grantReadWrite(workerRole);
    // タイトル固有アセット(ゲーム本体+WINEPREFIX+MOD)のダウンロード用(Issue #22)。
    titleAssetsBucket.grantRead(workerRole);
    jobsTable.grantReadWriteData(workerRole);
    workerRepo.grantPull(workerRole);
    // awslogs ドライバはストリーム作成とイベント送出を行う。
    workerLogGroup.grantWrite(workerRole);
    // taskToken 経由で Step Functions へ成功/失敗(Spot中断の早期通知含む)を通知する。
    // これらのアクションはリソースレベル権限に対応していないため Resource: "*" が必要
    // (AWS公式ドキュメント上の制約)。
    workerRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["states:SendTaskSuccess", "states:SendTaskFailure", "states:SendTaskHeartbeat"],
        resources: ["*"],
      }),
    );

    const workerInstanceProfile = new iam.InstanceProfile(this, "WorkerInstanceProfile", {
      role: workerRole,
    });

    // 自宅サーバーの常駐デーモン(`home-worker/`、Issue #49)が assume するロール。
    // 権限は「EC2ワーカーができること」+「オファーの探索とclaim」+「コンテナログの
    // CloudWatch転送」に限定する。EC2ワーカーと違いインスタンスプロファイルを
    // 使えないため、**長期のアクセスキーを自宅マシンへ置かずに済むよう
    // AssumeRoleで短命クレデンシャル(既定1時間)にする**のが要点。
    //
    // 信頼ポリシーはアカウント内プリンシパル全体にしてある。実際に assume できるのは
    // 「自身のIAMポリシーで`sts:AssumeRole`を許可された」プリンシパルだけなので、
    // 誰が使えるかの実質的な制御は手動で作るIAMユーザー側のポリシーで行う
    // (アクセスキーはCloudFormationで作れない・作るべきでないため、管理画面トークンの
    // SSM投入と同じく手動運用にしている。手順は`infra/README.md`参照)。
    const homeWorkerRole = new iam.Role(this, "HomeWorkerRole", {
      assumedBy: new iam.AccountPrincipal(this.account),
      description: "Sattori home recording worker (Issue #49)",
      // デーモンはコンテナ起動時にこの期間ぶんの一時認証情報を発行して渡す
      // (`home-worker/src/credentials.ts`)。**ジョブ1本の最長所要時間(録画60分+変換)
      // より確実に長い**必要がある——短いと録画の途中でコンテナ内のS3/DynamoDB
      // 呼び出しが認証エラーで落ちる(コンテナ内には再取得の手段が無い)。
      maxSessionDuration: Duration.hours(4),
    });
    uploadBucket.grantRead(homeWorkerRole);
    outputBucket.grantReadWrite(homeWorkerRole);
    titleAssetsBucket.grantRead(homeWorkerRole);
    // ジョブのオファー探索(GSIのQuery)・claim・進捗更新。`grantReadWriteData`は
    // テーブル本体とすべてのインデックスを対象に含む。
    jobsTable.grantReadWriteData(homeWorkerRole);
    // 自分のハートビートを書く。他ワーカーの行を消せる必要は無いのでDeleteは与えない。
    workersTable.grant(homeWorkerRole, "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem");
    workerRepo.grantPull(homeWorkerRole);
    // EC2ワーカーはdockerのawslogsドライバがログを送るが、自宅ではdockerデーモンに
    // AWS認証情報を持たせたくないため、デーモン自身がコンテナ出力を読んで
    // 同じロググループ・同じストリーム名(=jobId)へ転送する。これにより管理画面の
    // ログ表示(Issue #58)がワーカーの種別によらず同じように使える。
    workerLogGroup.grantWrite(homeWorkerRole);
    // 録画の成否をtaskToken経由で通知する(EC2ワーカーと同じ契約)。
    homeWorkerRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["states:SendTaskSuccess", "states:SendTaskFailure", "states:SendTaskHeartbeat"],
        resources: ["*"],
      }),
    );

    // Docker 同梱の ECS 最適化 AL2023 AMI を利用(UserData で docker run するだけ)。
    const workerAmiId = ssm.StringParameter.valueForStringParameter(
      this,
      "/aws/service/ecs/optimized-ami/amazon-linux-2023/recommended/image_id",
    );

    // ワーカー起動の基点となる Launch Template。AMI/インスタンスタイプ/IAM/SGはここで
    // 固定し、ジョブ毎に変わる UserData のみ実行時(apps/api の launchRecordingInstance)
    // が `CreateLaunchTemplateVersion` で上書きした新バージョンを作る。
    // UserData はプレースホルダ(実際に使われることはない)。
    const workerLaunchTemplate = new ec2.CfnLaunchTemplate(this, "WorkerLaunchTemplate", {
      launchTemplateData: {
        imageId: workerAmiId,
        instanceType: "c7i.xlarge",
        iamInstanceProfile: { arn: workerInstanceProfile.instanceProfileArn },
        securityGroupIds: [workerSg.securityGroupId],
        instanceInitiatedShutdownBehavior: "terminate",
        userData: Buffer.from("#!/bin/bash\nexit 0\n", "utf-8").toString("base64"),
      },
    });

    // --- API(Lambda + HTTP API) -------------------------------------------

    // 全AZのサブネットをそのままEC2 Fleetの起動先候補にする。us-east-1運用時は
    // レガシーAZ(us-east-1e)をここで除外していたが(Issue #29)、eu-south-2には
    // レガシーAZが無いためフィルタリングは不要。
    const workerSubnets = vpc.publicSubnets;

    const commonEnv: Record<string, string> = {
      UPLOAD_BUCKET: uploadBucket.bucketName,
      OUTPUT_BUCKET: outputBucket.bucketName,
      CDN_DOMAIN: mediaDistribution.distributionDomainName,
      JOBS_TABLE: jobsTable.tableName,
      WORKER_IMAGE: `${workerRepo.repositoryUri}:latest`,
      TITLE_ASSETS_BUCKET: titleAssetsBucket.bucketName,
      WORKER_LOG_GROUP: workerLogGroup.logGroupName,
      WORKER_SUBNET_IDS: workerSubnets.map((subnet) => subnet.subnetId).join(","),
      WORKER_LAUNCH_TEMPLATE_ID: workerLaunchTemplate.ref,
      EMAIL_RATE_LIMIT_TABLE: emailRateLimitTable.tableName,
      SETTINGS_TABLE: settingsTable.tableName,
      WORKERS_TABLE: workersTable.tableName,
      SES_FROM_ADDRESS: sesFromAddress,
      SES_REPLY_TO_ADDRESS: sesReplyToAddress,
      // eu-south-2にはSESが存在しないため、Lambda側(apps/api/src/ses.ts)は
      // このリージョンを明示して`SESv2Client`を生成する。
      SES_REGION: props.sesRegion,
      // `SattoriEdgeStack`(us-east-1)が作ったConfigurationSet名。バウンス・苦情・
      // 拒否イベントをSNS経由で運用アラートへ流すための紐付け(Issue #133 OPS-1)。
      SES_CONFIGURATION_SET: props.sesConfigurationSetName,
      WEB_BASE_URL: `https://${webDomainName}`,
      // 訪問者アナリティクス（Issue #142）の集計に使う（`admin/getAnalytics.ts`、Issue #149）。
      // `RecordAnalyticsEventFn`は下記の専用環境変数で別途同じ値を受け取る。
      ANALYTICS_EVENTS_TABLE: analyticsEventsTable.tableName,
    };

    // `environment`省略時は`commonEnv`を使う。管理画面のauthorizer(Issue #51)のように
    // `commonEnv`とは無関係な環境変数だけを持たせたいLambdaのために上書きできるようにする。
    const makeHandler = (
      name: string,
      entry: string,
      environment: Record<string, string> = commonEnv,
      // メモリ・タイムアウトだけ既定と変えたいハンドラ向けの上書き（全件Scanで
      // 集計する`admin/getCosts.ts`など）。既定値で足りるハンドラは渡さないこと。
      overrides: Pick<NodejsFunctionProps, "memorySize" | "timeout"> = {},
    ) => {
      const fn = new NodejsFunction(this, name, {
        entry: join(API_HANDLERS, entry),
        handler: "handler",
        runtime: lambda.Runtime.NODEJS_22_X,
        timeout: Duration.seconds(30),
        environment,
        ...overrides,
        bundling: {
          // CJS で出力する。ESM 出力だと AWS SDK 内部の動的 require("node:https")
          // が Lambda(ESM) で "Dynamic require not supported" となり失敗するため。
          // @sattori/shared(ワークスペース依存)を含めてすべてバンドルする。
          externalModules: [],
        },
      });
      return fn;
    };

    const createUploadFn = makeHandler("CreateUploadFn", "createUpload.ts");
    const parseReplayFn = makeHandler("ParseReplayFn", "parseReplay.ts");
    const getJobFn = makeHandler("GetJobFn", "getJob.ts");
    const requestMagicLinkFn = makeHandler("RequestMagicLinkFn", "requestMagicLink.ts");
    // ページAで「低速録画」(Issue #68)を選べるかの判定に使う、自宅ワーカー(Issue #49)の
    // 空き状況の公開スナップショット。認証なしで公開するため、ハンドラ側で workerId 等の
    // 運用情報を落としてから返す(`handlers/getWorkerAvailability.ts`)。
    const getWorkerAvailabilityFn = makeHandler(
      "GetWorkerAvailabilityFn",
      "getWorkerAvailability.ts",
    );
    // Cookie無しのサーバーサイド計測（`POST /beacon`、Issue #142）。計測用テーブルの
    // 読み書きしか行わないため、他の管理系Lambdaと同様commonEnvを使わず専用の環境変数
    // だけを持たせる（`apps/api/README.md`「環境変数」参照）。SETTINGS_TABLE は
    // ハッシュ化訪問者ID用の日次salt保管に使う（Issue #144、`apps/api/src/analyticsSalt.ts`）。
    const recordAnalyticsEventFn = makeHandler(
      "RecordAnalyticsEventFn",
      "recordAnalyticsEvent.ts",
      {
        ANALYTICS_EVENTS_TABLE: analyticsEventsTable.tableName,
        SETTINGS_TABLE: settingsTable.tableName,
      },
    );

    // 権限付与
    uploadBucket.grantPut(createUploadFn); // 署名付き PUT URL 発行のため
    uploadBucket.grantRead(parseReplayFn); // アップロード済み .rpy を取得して解析するため
    jobsTable.grantReadData(getJobFn);
    workersTable.grantReadData(getWorkerAvailabilityFn);
    analyticsEventsTable.grantWriteData(recordAnalyticsEventFn);
    // 日次saltの読み取り・初回生成時の書き込みの両方が必要（Issue #144）。
    settingsTable.grantReadWriteData(recordAnalyticsEventFn);

    // マジックリンクの送信要求は、status:pending の JobRecord 作成(jobsTable書き込み)、
    // レート制限カウンタの読み書き、SESでの送信権限が必要。
    jobsTable.grantReadWriteData(requestMagicLinkFn);
    emailRateLimitTable.grantReadWriteData(requestMagicLinkFn);
    // キルスイッチ・月間コストガード判定（Issue #14）の読み取り専用。
    settingsTable.grantReadData(requestMagicLinkFn);
    // `replayInfo`をクライアントのJSONではなく`replayKey`から再取得・再パースして
    // 生成するため（Issue #133 OPS-1、`replay.ts`の`fetchReplayBytes()`）。
    uploadBucket.grantRead(requestMagicLinkFn);
    // SESアカウントがサンドボックス中は、送信元IDだけでなく送信先(受信者)の
    // メールアドレスも「検証済みID」としてIAMの権限チェック対象になる
    // (受信者ごとに個別の identity ARN が動的に検査される)。宛先はユーザー入力の
    // 任意アドレスでデプロイ時に特定できないため、Resourceはこのアカウント配下の
    // SES identity 全体(送信元ドメイン・任意の受信者アドレスの両方を含む)に絞る。
    // サンドボックス解除後は受信者側のチェックは行われなくなるが、Resourceを
    // 変更する必要はない。
    // `ConfigurationSetName`を指定してSendEmailを呼ぶ場合、SESv2はidentityに加えて
    // configuration-setリソースに対するIAM権限も別途チェックする。Issue #133で
    // ConfigurationSetを追加した際にこちらへの権限付与が漏れており、`AccessDeniedException`
    // (`... is not authorized to perform 'ses:SendEmail' on resource '...configuration-set/...'`)
    // で全てのメール送信が失敗する事故が発生した(2026-08-22)。
    const sesSendEmailResources = [
      `arn:aws:ses:${props.sesRegion}:${this.account}:identity/*`,
      `arn:aws:ses:${props.sesRegion}:${this.account}:configuration-set/${props.sesConfigurationSetName}`,
    ];
    requestMagicLinkFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ses:SendEmail"],
        resources: sesSendEmailResources,
      }),
    );

    // ジョブが status:done に遷移した瞬間に完了メールを送る(Issue #10)。
    // ワーカー(worker/, Python)ではなくJobsTableのDynamoDB Streamsを起点にする
    // ことで、ワーカー側にSESの権限・文面知識を持たせずに済む。
    const sendCompletionEmailFn = makeHandler(
      "SendCompletionEmailFn",
      "sendCompletionEmail.ts",
    );
    sendCompletionEmailFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ses:SendEmail"],
        resources: sesSendEmailResources,
      }),
    );
    sendCompletionEmailFn.addEventSource(
      new DynamoEventSource(jobsTable, {
        startingPosition: lambda.StartingPosition.TRIM_HORIZON,
        // "done"へのMODIFYイベントのみに絞り込み、無関係な更新(進捗率等)での
        // 無駄な起動を避ける。フィルタをすり抜けたレコード(旧状態が既にdoneだった場合等)
        // に対する最終防衛はハンドラ内(sendCompletionEmail.ts)でも行う。
        filters: [
          lambda.FilterCriteria.filter({
            eventName: lambda.FilterRule.isEqual("MODIFY"),
            dynamodb: {
              NewImage: {
                status: { S: lambda.FilterRule.isEqual("done") },
              },
            },
          }),
        ],
        retryAttempts: 3,
      }),
    );

    // --- 録画ジョブのオーケストレーション(Step Functions) -------------------
    // 1ジョブ = 1 Standard実行。Launch タスクが EC2 Fleet でワーカーを起動し、
    // ワーカー自身が taskToken 経由で成否を通知する(waitForTaskTokenパターン)。
    // Spot中断/タイムアウト時は HandleFailure が孤児インスタンスをterminateしつつ
    // リトライ可否を判定する(Issue #11)。

    // Launch は自宅ワーカー(Issue #49)へのオファー後、claimされるかを最大
    // `GameRoutingPolicy.offerWindowSeconds`(既定20秒)ぶんポーリングして待つため、
    // 既定の30秒タイムアウトでは足りない。待機は自宅ワーカーのハートビートが
    // 新鮮なときにしか発生しないので、通常のジョブでこの時間を消費することはない。
    // タイムアウト値は`@sattori/shared`の定数を唯一の出典にしてある(apps/api側の
    // `MAX_OFFER_WINDOW_SECONDS`がこの値から導出され、テストで整合を守っている)。
    const launchFn = makeHandler("LaunchFn", "sfn/launch.ts", commonEnv, {
      timeout: Duration.seconds(LAUNCH_LAMBDA_TIMEOUT_SECONDS),
    });
    const handleFailureFn = makeHandler("HandleFailureFn", "sfn/handleFailure.ts");

    jobsTable.grantReadWriteData(launchFn);
    // オファー可否の判断にハートビートを読む(書き込むのは自宅デーモンだけ)。
    workersTable.grantReadData(launchFn);
    // launchFn は EC2 Fleet を起動し、ワーカーロールを PassRole する。
    launchFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "ec2:CreateFleet",
          "ec2:CreateLaunchTemplateVersion",
          "ec2:RunInstances",
          "ec2:CreateTags",
          // 確保できたインスタンスのSpot単価をJobRecordへ記録するため(Issue #60、
          // コスト推定の入力)。リソース単位の絞り込みができない読み取り専用API。
          "ec2:DescribeSpotPriceHistory",
        ],
        resources: ["*"],
      }),
    );
    launchFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["iam:PassRole"],
        resources: [workerRole.roleArn],
      }),
    );

    jobsTable.grantReadWriteData(handleFailureFn);
    handleFailureFn.addToRolePolicy(
      new iam.PolicyStatement({
        // DescribeInstancesは孤児インスタンスをタグ(sattori:jobId)から探すため
        // (Issue #23)。`JobRecord.instanceId`はLaunchが`CreateFleet`の後に書くので、
        // 書き込む前に死んだ試行のインスタンスはタグ経由でしか見つけられない。
        // どちらも対象が実行時にしか決まらない(DescribeInstancesはそもそも
        // リソースレベルの権限指定に非対応)ためResource:*で付与する。
        actions: ["ec2:TerminateInstances", "ec2:DescribeInstances"],
        resources: ["*"],
      }),
    );

    const launchTask = new tasks.LambdaInvoke(this, "Launch", {
      lambdaFunction: launchFn,
      integrationPattern: sfn.IntegrationPattern.WAIT_FOR_TASK_TOKEN,
      payload: sfn.TaskInput.fromObject({
        taskToken: sfn.JsonPath.taskToken,
        jobId: sfn.JsonPath.stringAt("$.jobId"),
        attempt: sfn.JsonPath.numberAt("$.attempt"),
      }),
      // 録画ジョブ全体のフェイルセーフタイムアウト。これを超えてもワーカーから
      // taskTokenの応答が無ければ強制的に失敗させ、HandleFailureで後始末する。
      // 内訳は「録画自体のタイムアウト + 720pアップスケール変換・S3アップロード・
      // DynamoDB更新・taskToken通知の余裕(30分)」。
      //
      // 録画のタイムアウト(`worker/recording_common.py`の`TIMEOUT_SEC`)は等倍で60分
      // だが、低速録画(Issue #68)ではゲーム進行が半分の速度になるぶん同じ比率で
      // 伸びて120分になる。**このフェイルセーフはジョブごとに変えられない**ので、
      // 最も長くなる低速録画に合わせて 120 + 30 = 150分にしてある。等倍のジョブが
      // これで不利になることはない——ハートビート(下記、15分)が実際の死活監視を
      // 担っており、ワーカーが黙ればそちらが先に発火するため。
      taskTimeout: sfn.Timeout.duration(Duration.minutes(150)),
      // ワーカーが生きているかの死活監視(Issue #49)。ワーカーコンテナは起動直後から
      // 60秒間隔で `SendTaskHeartbeat` を送る(`worker/task_heartbeat.py`)ので、
      // 15分途絶えたら「そのワーカーはもう動いていない」と判断してよい。
      //
      // これが要るのは主に自宅ワーカーのためである。EC2ワーカーなら電源断・Spot中断は
      // インスタンスの消滅として観測できるが、自宅マシンの停電・回線断・クラッシュは
      // AWS側から一切見えず、これが無いとタスクタイムアウト(90分)までジョブが
      // 「録画中」のまま固まる。ハートビートが途切れれば`HandleFailure`が走り、
      // claimを解除して(＝復帰したデーモンが録画を続けないようにして)EC2で
      // やり直せる。EC2ワーカーにとっても失敗検知が90分→15分に縮まる副次的な利点がある。
      //
      // **デプロイ順序の注意**: ハートビートを送らない古いワーカーイメージが
      // ECRに残っていると、全ジョブが15分でタイムアウトする。ワーカーイメージの
      // push を `cdk deploy` より先に行うこと(`infra/README.md`参照)。
      heartbeatTimeout: sfn.Timeout.duration(Duration.minutes(15)),
      resultPath: sfn.JsonPath.DISCARD,
    });

    const handleFailureTask = new tasks.LambdaInvoke(this, "HandleFailure", {
      lambdaFunction: handleFailureFn,
      payload: sfn.TaskInput.fromObject({
        jobId: sfn.JsonPath.stringAt("$.jobId"),
        attempt: sfn.JsonPath.numberAt("$.attempt"),
        // Launch の Catch（`$.error`、下記）で捕捉した失敗種別を渡す。handleFailure側は
        // これを見て「再試行しても解決しない決定的な失敗」を早期に打ち切る（Issue #131）。
        error: {
          Error: sfn.JsonPath.stringAt("$.error.Error"),
          Cause: sfn.JsonPath.stringAt("$.error.Cause"),
        },
      }),
      payloadResponseOnly: true,
      resultPath: "$.handleFailureResult",
    });

    const incrementAttempt = new sfn.Pass(this, "IncrementAttempt", {
      parameters: {
        jobId: sfn.JsonPath.stringAt("$.jobId"),
        attempt: sfn.JsonPath.mathAdd(sfn.JsonPath.numberAt("$.attempt"), 1),
      },
    });

    // Spot中断の早期失敗通知はワーカーの処理継続中に送られるため、失敗直後に
    // 即terminate/リトライすると完走できたはずのジョブまで潰してしまう。3分待って
    // からHandleFailureがジョブの最終状態を確認するため、この待機がリトライ間隔も兼ねる。
    const waitBeforeCheck = new sfn.Wait(this, "WaitBeforeCheck", {
      time: sfn.WaitTime.duration(Duration.minutes(3)),
    });

    const retryChoice = new sfn.Choice(this, "ShouldRetry?")
      .when(
        sfn.Condition.booleanEquals("$.handleFailureResult.shouldRetry", true),
        incrementAttempt.next(launchTask),
      )
      .otherwise(new sfn.Fail(this, "JobFailed"));

    // HandleFailure Lambda 自体が例外を投げても（DynamoDB/EC2 API の一時的な
    // スロットリング等）、再試行判定を経ずに実行全体が失敗してジョブが非終端状態の
    // まま固まらないようにする。数回のリトライでも解消しない場合は明示的にFailへ
    // 倒し、実行自体は必ず終端させる。
    handleFailureTask.addRetry({
      errors: ["States.ALL"],
      maxAttempts: 3,
      interval: Duration.seconds(5),
      backoffRate: 2,
    });
    const handleFailureCrashed = new sfn.Fail(this, "HandleFailureCrashed", {
      error: "HandleFailureCrashed",
      cause: "HandleFailure Lambda が例外を送出したため実行を終了します。孤児インスタンスが残っている可能性があります",
    });
    handleFailureTask.addCatch(handleFailureCrashed, { resultPath: "$.handleFailureError" });

    launchTask.addCatch(waitBeforeCheck.next(handleFailureTask).next(retryChoice), {
      resultPath: "$.error",
    });
    launchTask.next(new sfn.Succeed(this, "JobSucceeded"));

    const stateMachine = new sfn.StateMachine(this, "RecordingStateMachine", {
      definitionBody: sfn.DefinitionBody.fromChainable(launchTask),
      stateMachineType: sfn.StateMachineType.STANDARD,
    });

    // ジョブページへのアクセス(jobIdのみで認可)がジョブをqueuedへ遷移させ
    // Step Functionsを起動する(フェーズ1で createJobFn が担っていた即時起動を
    // Issue #9で置き換えた。tokenは廃止し、jobId自体を秘密値として扱う設計)。
    const startJobFn = makeHandler("StartJobFn", "startJob.ts");
    jobsTable.grantReadWriteData(startJobFn);
    stateMachine.grantStartExecution(startJobFn);
    // キルスイッチ判定用（Issue #130）。GetItem 1回のみでキャッシュしない
    // （`settings.ts`参照）。
    settingsTable.grantReadData(startJobFn);
    // STATE_MACHINE_ARN は startJobFn だけに付与する(commonEnv には含めない)。
    // ステートマシンは launchFn/handleFailureFn を呼び出す(Lambda ARN に依存)ため、
    // それらの環境変数がステートマシンARNを参照すると CloudFormation の循環依存になる。
    startJobFn.addEnvironment("STATE_MACHINE_ARN", stateMachine.stateMachineArn);

    // --- 孤児インスタンスの定期掃除(Issue #23) ------------------------------
    // ジョブ側の後始末(HandleFailure・管理画面の緊急停止)は「そのハンドラ自体が
    // 動けたなら」という前提に立っており、Launch が `instanceId` をDynamoDBへ書く
    // 前にタイムアウトした場合や、後始末そのものが失敗した場合には、誰にも
    // terminateされないEC2が残って課金だけが続く。この掃除役は**AWS上に実在する
    // インスタンス(タグ`sattori:jobId`)を起点に走査する**ことで、ジョブレコードに
    // 痕跡が無い孤児も拾えるようにした最後の網。
    // 判定を安全側へ倒す仕組み(猶予・最新1台の保護)は
    // `apps/api/src/orphanInstances.ts` 参照。
    const sweepOrphanInstancesFn = makeHandler(
      "SweepOrphanInstancesFn",
      "sweepOrphanInstances.ts",
      // commonEnvは使わない(必要なのはジョブレコードの参照と実行ARNの組み立てだけ)。
      { JOBS_TABLE: jobsTable.tableName },
      // 生存インスタンス1台につきDescribeExecution+GetItemを直列に引くため、
      // 既定の30秒では孤児が多数溜まった場合に足りない可能性がある。走査対象は
      // 通常0〜数台なので、広げてもコストはほぼ増えない。
      { timeout: Duration.minutes(3) },
    );
    jobsTable.grantReadData(sweepOrphanInstancesFn);
    // 実行の生死はジョブのstatusでは代用できない(`apps/api/src/stepFunctions.ts`)。
    stateMachine.grantExecution(sweepOrphanInstancesFn, "states:DescribeExecution");
    sweepOrphanInstancesFn.addEnvironment("STATE_MACHINE_ARN", stateMachine.stateMachineArn);
    sweepOrphanInstancesFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ec2:DescribeInstances", "ec2:TerminateInstances"],
        resources: ["*"],
      }),
    );
    new events.Rule(this, "OrphanInstanceSweepRule", {
      description: "孤児化した録画EC2インスタンスを定期的に検知・terminateする(Issue #23)",
      // 間隔は`@sattori/shared`の定数が唯一の出典(判定の猶予と対で意味を持つため)。
      schedule: events.Schedule.rate(Duration.minutes(ORPHAN_SWEEP_INTERVAL_MINUTES)),
      targets: [new targets.LambdaFunction(sweepOrphanInstancesFn)],
    });

    // --- 管理画面(`/admin`, Issue #51) --------------------------------------
    // ユーザーは管理者1人固定のため、Cognito等ではなくSSM Parameter Store
    // (SecureString)に置いた共有トークンをLambda Authorizerで検証する方式にする。
    // SecureStringはCloudFormation/CDKでは作成できないため、ここでは名前で参照する
    // だけで値には触れない(`cdk deploy`前に手動で`aws ssm put-parameter`する運用。
    // 詳細は infra/README.md・CLAUDE.local.md 参照)。
    const ADMIN_TOKEN_PARAMETER_NAME = "/sattori/admin/token";
    const adminAuthorizerFn = makeHandler("AdminAuthorizerFn", "admin/authorizer.ts", {
      ADMIN_TOKEN_PARAMETER_NAME,
    });
    const adminTokenParam = ssm.StringParameter.fromSecureStringParameterAttributes(
      this,
      "AdminTokenParam",
      { parameterName: ADMIN_TOKEN_PARAMETER_NAME },
    );
    // `adminTokenParam.stringValue`は参照しないこと。参照するとCFnの動的参照
    // (`{{resolve:ssm-secure:...}}`)が生成され、SecureStringの値が合成物(テンプレート)
    // に染み出してしまう。`grantRead`はARNしか使わないため安全。
    adminTokenParam.grantRead(adminAuthorizerFn);
    adminAuthorizerFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["kms:Decrypt"],
        // AWS管理キー(alias/aws/ssm)のキーIDは合成時に分からないため、
        // kms:ViaServiceでSSM経由の復号のみに絞ることでResource:*を許容する。
        resources: ["*"],
        conditions: { StringEquals: { "kms:ViaService": `ssm.${this.region}.amazonaws.com` } },
      }),
    );
    const adminAuthorizer = new HttpLambdaAuthorizer("AdminAuthorizer", adminAuthorizerFn, {
      authorizerName: "AdminTokenAuthorizer",
      identitySource: ["$request.header.Authorization"],
      responseTypes: [HttpLambdaResponseType.SIMPLE],
      // トークンローテーション時の失効反映が遅れるトレードオフと引き換えに、
      // 一覧・詳細画面の頻繁なポーリング/遷移がAuthorizer Lambdaを都度起動しないようにする。
      resultsCacheTtl: Duration.minutes(5),
    });

    const adminListJobsFn = makeHandler("AdminListJobsFn", "admin/listJobs.ts");
    jobsTable.grantReadData(adminListJobsFn);

    const adminGetJobDetailFn = makeHandler("AdminGetJobDetailFn", "admin/getJobDetail.ts");
    jobsTable.grantReadData(adminGetJobDetailFn);
    uploadBucket.grantRead(adminGetJobDetailFn); // .rpyの署名付きダウンロードURL発行のため
    // 720p変換のffmpeg生ログ(worker-logs/プレフィックス)の存在確認・署名付きURL発行のため
    // (Issue #58フォローアップ)。動画本体のURLはbuildVideoDownloadUrlでCDN URLを組み立てる
    // だけなので不要だが、こちらはCDN配信しない診断用データのためS3署名付きURLを使う。
    outputBucket.grantRead(adminGetJobDetailFn);

    const adminGetExecutionFn = makeHandler("AdminGetExecutionFn", "admin/getExecution.ts");
    stateMachine.grantRead(adminGetExecutionFn);
    // STATE_MACHINE_ARN はstartJobFnと同様、循環依存回避のため個別付与する
    // (ステートマシンは管理用Lambdaを呼び出さないため、実際には循環しないが
    // commonEnvへ混ぜず用途を揃えておく)。
    adminGetExecutionFn.addEnvironment("STATE_MACHINE_ARN", stateMachine.stateMachineArn);

    // ワーカーのCloudWatch Logs閲覧(Issue #58)。`instanceId`はDynamoDBに持つ情報だが、
    // getExecutionFnと同じ最小権限の考え方でjobsTable読み取り権限は持たせない
    // (フロントが`GET /admin/jobs/{jobId}`で既に持つ値をクエリパラメータで渡す)。
    const adminGetLogsFn = makeHandler("AdminGetLogsFn", "admin/getLogs.ts", {
      WORKER_LOG_GROUP: workerLogGroup.logGroupName,
    });
    workerLogGroup.grantRead(adminGetLogsFn);
    // UserData(bootstrap)段階の失敗はCloudWatch Logsに乗らないため、EC2コンソール出力を
    // 代替表示するフォールバック用(`ec2.ts`のUserData内`trap`コメント参照)。
    // GetConsoleOutputはリソースレベル権限に対応しているため、任意のインスタンスに限定する
    // (Resource: "*" にはしない)。
    adminGetLogsFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ec2:GetConsoleOutput"],
        resources: [`arn:aws:ec2:${this.region}:${this.account}:instance/*`],
      }),
    );

    // ジョブの緊急停止・再実行（Issue #59）。参照系の管理APIと違い状態を変える
    // ため、フロント側で確認ダイアログを挟んだ上でPOSTさせる（DELETEを使うと
    // `corsPreflight.allowMethods`の拡張も必要になるため、POSTに揃える）。
    const adminStopJobFn = makeHandler("AdminStopJobFn", "admin/stopJob.ts");
    jobsTable.grantReadWriteData(adminStopJobFn);
    // DescribeExecutionは停止可否の判定に使う。ジョブのstatusは「実行が終わったか」の
    // 代理条件にならない（ワーカーがSendTaskFailureより先にfailedを書くため）ので、
    // 実行の生死を直接問い合わせる必要がある。
    stateMachine.grantExecution(adminStopJobFn, "states:StopExecution", "states:DescribeExecution");
    adminStopJobFn.addToRolePolicy(
      new iam.PolicyStatement({
        // handleFailureFnと同じく、対象インスタンスは実行時にしか決まらないため
        // TerminateInstancesはResource:*で付与する。DescribeInstancesは孤児
        // インスタンスをタグ(sattori:jobId)から探すため（そもそもリソースレベルの
        // 権限指定に非対応）。
        actions: ["ec2:TerminateInstances", "ec2:DescribeInstances"],
        resources: ["*"],
      }),
    );
    adminStopJobFn.addEnvironment("STATE_MACHINE_ARN", stateMachine.stateMachineArn);

    // 再実行は元ジョブを新しいjobIdへ複製して起動する（同一jobIdでの再起動は
    // startPendingJobの冪等性前提とStep Functionsの実行名の一意性を壊すため。
    // `apps/api/src/handlers/admin/retryJob.ts`参照）。
    const adminRetryJobFn = makeHandler("AdminRetryJobFn", "admin/retryJob.ts");
    jobsTable.grantReadWriteData(adminRetryJobFn);
    stateMachine.grantStartExecution(adminRetryJobFn);
    // 元ジョブの実行がまだ動いていないか（＝複製すると二重録画になるか）の確認用。
    stateMachine.grantExecution(adminRetryJobFn, "states:DescribeExecution");
    uploadBucket.grantRead(adminRetryJobFn); // 元の.rpyが残っているかの確認のため
    adminRetryJobFn.addEnvironment("STATE_MACHINE_ARN", stateMachine.stateMachineArn);

    // コスト集計（Issue #60）はJobsTableの全件Scan + アプリ側集計。月1000ジョブ規模
    // では素朴なScanで十分だが、件数に比例して実行時間が伸びるためタイムアウトと
    // メモリだけ既定より広げておく（`apps/api/src/adminCosts.ts`参照）。
    const adminGetCostsFn = makeHandler("AdminGetCostsFn", "admin/getCosts.ts", commonEnv, {
      timeout: Duration.seconds(60),
      memorySize: 512,
    });
    jobsTable.grantReadData(adminGetCostsFn);
    // CloudFrontの実配信量（Issue #163、`apps/api/src/cloudfrontMetrics.ts`）。
    // `STATE_MACHINE_ARN`と同じく、このハンドラ専用の環境変数として個別付与する
    // （commonEnvに混ぜると他の全Lambdaに無関係な変数が伝播するため）。
    adminGetCostsFn.addEnvironment("CLOUDFRONT_DISTRIBUTION_ID", mediaDistribution.distributionId);
    // GetMetricDataはリソースレベル権限に非対応のためResource: "*"がAWS側の制約
    // として必要（`adminGetLogsFn`のGetConsoleOutputと違い個別インスタンスへ絞れない）。
    adminGetCostsFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["cloudwatch:GetMetricData"],
        resources: ["*"],
      }),
    );

    // 訪問者アナリティクス集計（Issue #149）。`AnalyticsEventsTable`はPK=eventDateなので
    // 全件Scanではなく日付ごとにQueryを発行するが（`apps/api/src/adminAnalytics.ts`）、
    // 最大90日ぶん並行に投げるためタイムアウト・メモリはadminGetCostsFnと同じだけ広げる。
    const adminGetAnalyticsFn = makeHandler("AdminGetAnalyticsFn", "admin/getAnalytics.ts", commonEnv, {
      timeout: Duration.seconds(60),
      memorySize: 512,
    });
    analyticsEventsTable.grantReadData(adminGetAnalyticsFn);

    // キルスイッチ・月間コストガード（Issue #14）。どちらも`estimateCurrentMonthCostUsd()`
    // 経由でJobsTableの全件Scanを行うため、adminGetCostsFnと同じくタイムアウト・
    // メモリを広げておく。
    const adminGetSettingsFn = makeHandler("AdminGetSettingsFn", "admin/getSettings.ts", commonEnv, {
      timeout: Duration.seconds(60),
      memorySize: 512,
    });
    settingsTable.grantReadData(adminGetSettingsFn);
    jobsTable.grantReadData(adminGetSettingsFn);

    const adminUpdateSettingsFn = makeHandler(
      "AdminUpdateSettingsFn",
      "admin/updateSettings.ts",
      commonEnv,
      { timeout: Duration.seconds(60), memorySize: 512 },
    );
    settingsTable.grantReadWriteData(adminUpdateSettingsFn);
    jobsTable.grantReadData(adminUpdateSettingsFn);

    const httpApi = new apigw.HttpApi(this, "HttpApi", {
      corsPreflight: {
        allowOrigins: ["*"],
        allowMethods: [apigw.CorsHttpMethod.GET, apigw.CorsHttpMethod.POST],
        allowHeaders: ["content-type", "authorization"],
      },
    });
    httpApi.addRoutes({
      path: "/uploads",
      methods: [apigw.HttpMethod.POST],
      integration: new HttpLambdaIntegration("CreateUploadInt", createUploadFn),
    });
    httpApi.addRoutes({
      path: "/replays/parse",
      methods: [apigw.HttpMethod.POST],
      integration: new HttpLambdaIntegration("ParseReplayInt", parseReplayFn),
    });
    httpApi.addRoutes({
      path: "/magic-links",
      methods: [apigw.HttpMethod.POST],
      integration: new HttpLambdaIntegration("RequestMagicLinkInt", requestMagicLinkFn),
    });
    httpApi.addRoutes({
      path: "/jobs/{jobId}",
      methods: [apigw.HttpMethod.GET],
      integration: new HttpLambdaIntegration("GetJobInt", getJobFn),
    });
    httpApi.addRoutes({
      path: "/worker-availability",
      methods: [apigw.HttpMethod.GET],
      integration: new HttpLambdaIntegration(
        "GetWorkerAvailabilityInt",
        getWorkerAvailabilityFn,
      ),
    });
    // Cookie無しのサーバーサイド計測（Issue #142）。フロントエンドはこのパスを
    // API_BASE経由ではなく常に相対パス`/beacon`で叩く——CloudFront(WebCdn)の
    // `/beacon`ビヘイビア（後述）を経由させて`CloudFront-Viewer-Country`ヘッダーを
    // 得るため（`apps/web/src/api/analytics.ts`）。
    httpApi.addRoutes({
      path: "/beacon",
      methods: [apigw.HttpMethod.POST],
      integration: new HttpLambdaIntegration("RecordAnalyticsEventInt", recordAnalyticsEventFn),
    });
    httpApi.addRoutes({
      path: "/jobs/{jobId}/start",
      methods: [apigw.HttpMethod.POST],
      integration: new HttpLambdaIntegration("StartJobInt", startJobFn),
    });
    httpApi.addRoutes({
      path: "/admin/jobs",
      methods: [apigw.HttpMethod.GET],
      integration: new HttpLambdaIntegration("AdminListJobsInt", adminListJobsFn),
      authorizer: adminAuthorizer,
    });
    httpApi.addRoutes({
      path: "/admin/jobs/{jobId}",
      methods: [apigw.HttpMethod.GET],
      integration: new HttpLambdaIntegration("AdminGetJobDetailInt", adminGetJobDetailFn),
      authorizer: adminAuthorizer,
    });
    httpApi.addRoutes({
      path: "/admin/jobs/{jobId}/execution",
      methods: [apigw.HttpMethod.GET],
      integration: new HttpLambdaIntegration("AdminGetExecutionInt", adminGetExecutionFn),
      authorizer: adminAuthorizer,
    });
    httpApi.addRoutes({
      path: "/admin/jobs/{jobId}/logs",
      methods: [apigw.HttpMethod.GET],
      integration: new HttpLambdaIntegration("AdminGetLogsInt", adminGetLogsFn),
      authorizer: adminAuthorizer,
    });
    httpApi.addRoutes({
      path: "/admin/jobs/{jobId}/stop",
      methods: [apigw.HttpMethod.POST],
      integration: new HttpLambdaIntegration("AdminStopJobInt", adminStopJobFn),
      authorizer: adminAuthorizer,
    });
    httpApi.addRoutes({
      path: "/admin/jobs/{jobId}/retry",
      methods: [apigw.HttpMethod.POST],
      integration: new HttpLambdaIntegration("AdminRetryJobInt", adminRetryJobFn),
      authorizer: adminAuthorizer,
    });
    httpApi.addRoutes({
      path: "/admin/costs",
      methods: [apigw.HttpMethod.GET],
      integration: new HttpLambdaIntegration("AdminGetCostsInt", adminGetCostsFn),
      authorizer: adminAuthorizer,
    });
    httpApi.addRoutes({
      path: "/admin/analytics",
      methods: [apigw.HttpMethod.GET],
      integration: new HttpLambdaIntegration("AdminGetAnalyticsInt", adminGetAnalyticsFn),
      authorizer: adminAuthorizer,
    });
    httpApi.addRoutes({
      path: "/admin/settings",
      methods: [apigw.HttpMethod.GET],
      integration: new HttpLambdaIntegration("AdminGetSettingsInt", adminGetSettingsFn),
      authorizer: adminAuthorizer,
    });
    httpApi.addRoutes({
      path: "/admin/settings",
      // POST/PATCHの使い分けはadmin/stopJob.ts・admin/retryJob.tsと同じ理由
      // （corsPreflight.allowMethodsの拡張を避けるため更新系だがPOSTに揃える）。
      methods: [apigw.HttpMethod.POST],
      integration: new HttpLambdaIntegration("AdminUpdateSettingsInt", adminUpdateSettingsFn),
      authorizer: adminAuthorizer,
    });

    // --- 静的フロントエンド(S3 + CloudFront) ------------------------------

    const webBucket = new s3.Bucket(this, "WebBucket", {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // カスタムドメイン用証明書。CloudFront にアタッチする証明書は us-east-1 必須のため、
    // このスタック(eu-south-2)では作成できず`SattoriEdgeStack`(us-east-1)が作った
    // 証明書をARN経由でインポートする（詳細は同スタックのコメント参照）。
    const webCertificate = acm.Certificate.fromCertificateArn(
      this,
      "WebCertificate",
      props.webCertificateArn,
    );

    // SPAのフォールバックを言語別に振り分けるビューワーリクエスト関数。
    // 以前は errorResponses(403/404 -> /index.html)でフォールバックしていたが、それだと
    // `/en/jobs/xxx` にも日本語版HTMLが配られてしまい、OGP・title・`<html lang>` を
    // 言語ごとに出し分けられない(クローラーはJSを実行しないため、React側の書き換えでは
    // unfurlに反映されない)。フロントは `dist/index.html`(ja) と `dist/en/index.html`(en)
    // の2枚を吐くので(`apps/web/vite.config.ts`)、拡張子の無いパスを言語別のHTMLへ
    // 書き換える。拡張子つき(= 実ファイル)はそのままオリジンへ通すため、存在しない
    // アセットが 200 + HTML で返る従来の挙動も解消される。
    const webRoutingFunction = new cloudfront.Function(this, "WebRouting", {
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      comment: "SPA fallback with /en locale prefix",
      code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  var uri = request.uri;
  // 末尾セグメントに拡張子があれば実ファイル要求(jobIdはUUIDなのでドットを含まない)。
  if (uri.slice(uri.lastIndexOf('/') + 1).indexOf('.') !== -1) {
    return request;
  }
  if (uri === '/en' || uri.indexOf('/en/') === 0) {
    request.uri = '/en/index.html';
  } else {
    request.uri = '/index.html';
  }
  return request;
}
`),
    });

    const webDistribution = new cloudfront.Distribution(this, "WebCdn", {
      defaultRootObject: "index.html",
      domainNames: [webDomainName],
      certificate: webCertificate,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(webBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        functionAssociations: [
          {
            function: webRoutingFunction,
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          },
        ],
      },
      additionalBehaviors: {
        // Cookie無しの計測ビーコン（`/beacon`、Issue #142）。他のAPIエンドポイントは
        // CloudFrontを経由せず直接HTTP APIを叩く構成（`apps/web/README.md`
        // 「APIクライアント」）だが、このパスだけは例外的にCloudFrontを前段に置く。
        // `CloudFront-Viewer-Country`ヘッダーから国を得るには、CloudFrontを経由させる
        // 以外に方法が無いため。理由の詳細は
        // `docs/decisions/0024-cookieless-analytics-beacon.md`。
        "/beacon": {
          // HttpApiはカスタムドメイン未設定だと`domainName`を直接持たないため、
          // `apiEndpoint`(https://<id>.execute-api.<region>.amazonaws.com)から
          // ホスト名部分だけを取り出す（CDKでの定番の回避策）。
          origin: new origins.HttpOrigin(Fn.select(2, Fn.split("/", httpApi.apiEndpoint))),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          // 既定のビヘイビアはGET/HEADのみ許可のため、POSTを転送するには明示が要る。
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          // 計測イベントは1件ごとに内容が異なるためキャッシュ不可。
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          // `ALL_VIEWER_AND_CLOUDFRONT_2022`はviewerのHostヘッダー（カスタムドメイン）
          // をそのままオリジンへ転送してしまい、API Gatewayがオリジン自身のドメインと
          // 不一致として403 Forbiddenを返す（Issue #151）。`ALL_VIEWER_EXCEPT_HOST_HEADER`
          // はHostヘッダーだけを除外しつつ、CloudFront-Viewer-Countryを含む位置情報系
          // ヘッダーは引き続き転送するため、API Gateway/Lambda Function URLオリジン
          // 向けにAWSが用意した想定通りの組み合わせになる。
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
      },
      comment: "Sattori Web",
    });

    // web のビルド成果物があればデプロイする(cdk deploy 前に pnpm --filter web build)。
    if (existsSync(WEB_DIST)) {
      new s3deploy.BucketDeployment(this, "WebDeploy", {
        sources: [s3deploy.Source.asset(WEB_DIST)],
        destinationBucket: webBucket,
        distribution: webDistribution,
        distributionPaths: ["/*"],
      });
    }

    // --- 運用アラート(OPS-3, Issue #135) -------------------------------------
    // 「録画が全部コケている」ことに気づく手段が無かった問題への対応。1名運用のため
    // 通知先は1本のSNSトピックへ束ねる(分散させると全部無視するようになる)。
    // us-east-1側(SESバウンス・苦情、AWS Budgets、Issue #133/#134)は
    // `SattoriEdgeStack`が別途持つ——CloudWatchアラームのSNSアクションは同一
    // リージョンのトピックしか指定できないため(`docs/decisions/0025`)。
    const opsAlertTopic = new sns.Topic(this, "OpsAlertTopic", {
      displayName: "Sattori Ops Alerts (eu-south-2: Step Functions/Lambda)",
    });
    opsAlertTopic.addSubscription(new subscriptions.EmailSubscription(props.opsAlertEmail));
    const opsAlertAction = new cwActions.SnsAction(opsAlertTopic);

    // 1. RecordingStateMachineの実行失敗(Issue #135で提案された閾値をそのまま採用:
    //    1時間で3件以上)。単発の失敗はStep Functions自身がリトライするため許容し、
    //    まとまった失敗だけを拾う。
    new cloudwatch.Alarm(this, "RecordingStateMachineFailedAlarm", {
      alarmDescription:
        "RecordingStateMachineの実行失敗が1時間で3件以上。docs/runbooks/ops-alerts.md参照",
      metric: stateMachine.metricFailed({ period: Duration.hours(1), statistic: "Sum" }),
      threshold: 3,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(opsAlertAction);

    // 2・3. Lambdaのエラー・スロットル(Issue #135で提案された閾値をそのまま採用:
    //    5分で1件以上)。当初`makeHandler`経由の全Lambda(21本)に個別配線していたが、
    //    それだけで42個のアラームを消費しCloudWatch AlarmのFree Tier(10個/月)を
    //    大幅に超過した(Issue #154)。`AWS/Lambda`名前空間がFunctionNameディメン
    //    ションなしで自動公開するアカウント全体集計のErrors/Throttlesに1本ずつ張る
    //    ことで2個に減らす(`docs/decisions/0027`)。新しいLambdaを足しても配線不要で
    //    自動的に対象へ入るが、発報時にどの関数が原因かはアラーム名からは分からない
    //    (`docs/runbooks/ops-alerts.md`)。
    const accountWideLambdaMetric = (metricName: "Errors" | "Throttles") =>
      new cloudwatch.Metric({
        namespace: "AWS/Lambda",
        metricName,
        statistic: "Sum",
        period: Duration.minutes(5),
      });
    new cloudwatch.Alarm(this, "AnyHandlerErrorsAlarm", {
      alarmDescription:
        "いずれかのLambda関数でエラーが5分で1件以上。docs/runbooks/ops-alerts.md参照",
      metric: accountWideLambdaMetric("Errors"),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(opsAlertAction);
    new cloudwatch.Alarm(this, "AnyHandlerThrottlesAlarm", {
      alarmDescription:
        "いずれかのLambda関数でスロットルが5分で1件以上。docs/runbooks/ops-alerts.md参照",
      metric: accountWideLambdaMetric("Throttles"),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(opsAlertAction);

    // 4. 完了メール送信の失敗(Issue #135で提案された閾値をそのまま採用: 1件以上)。
    //    `sendCompletionEmail.ts`はDynamoDB Streamsのリトライを避けるため例外を
    //    握り潰して`console.error`するだけ(`retryAttempts: 3`は発動し得ない設定に
    //    なっている)。ログのメトリクスフィルタで拾う以外に気づく手段が無い。
    const sendCompletionEmailFailedMetric = new logs.MetricFilter(
      this,
      "SendCompletionEmailFailedMetricFilter",
      {
        logGroup: logs.LogGroup.fromLogGroupName(
          this,
          "SendCompletionEmailLogGroup",
          `/aws/lambda/${sendCompletionEmailFn.functionName}`,
        ),
        filterPattern: logs.FilterPattern.stringValue("$.event", "=", "send_completion_email_failed"),
        metricNamespace: "Sattori",
        metricName: "SendCompletionEmailFailed",
      },
    ).metric({ period: Duration.minutes(5), statistic: "Sum" });
    new cloudwatch.Alarm(this, "SendCompletionEmailFailedAlarm", {
      alarmDescription: "完了メールの送信に1件以上失敗した。docs/runbooks/ops-alerts.md参照",
      metric: sendCompletionEmailFailedMetric,
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(opsAlertAction);

    // --- 出力 --------------------------------------------------------------

    new CfnOutput(this, "ApiUrl", { value: httpApi.apiEndpoint });
    new CfnOutput(this, "WebUrl", { value: `https://${webDomainName}` });
    // 外部 DNS 側で `sattori` を CNAME としてこのドメインへ向ける。
    new CfnOutput(this, "WebCdnDomain", { value: webDistribution.distributionDomainName });
    new CfnOutput(this, "MediaCdnDomain", { value: mediaDistribution.distributionDomainName });
    new CfnOutput(this, "WorkerRepoUri", { value: workerRepo.repositoryUri });
    // タイトル資産アップロード先(worker/README.md §8 参照)。
    new CfnOutput(this, "TitleAssetsBucketName", { value: titleAssetsBucket.bucketName });
    // 自宅ワーカー(Issue #49)の設定に必要な値。`home-worker/README.md`参照。
    new CfnOutput(this, "HomeWorkerRoleArn", { value: homeWorkerRole.roleArn });
    new CfnOutput(this, "JobsTableName", { value: jobsTable.tableName });
    new CfnOutput(this, "WorkersTableName", { value: workersTable.tableName });
    new CfnOutput(this, "UploadBucketName", { value: uploadBucket.bucketName });
    new CfnOutput(this, "OutputBucketName", { value: outputBucket.bucketName });
  }
}
