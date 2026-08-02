import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  CfnOutput,
  Duration,
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
import * as iam from "aws-cdk-lib/aws-iam";
import * as ses from "aws-cdk-lib/aws-ses";
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as apigw from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { HttpLambdaAuthorizer, HttpLambdaResponseType } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import * as tasks from "aws-cdk-lib/aws-stepfunctions-tasks";
import { OUTPUT_RETENTION_DAYS } from "@sattori/shared";
import { DynamoEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import type { Construct } from "constructs";

const HERE = dirname(fileURLToPath(import.meta.url));
const API_HANDLERS = join(HERE, "../../apps/api/src/handlers");
const WEB_DIST = join(HERE, "../../apps/web/dist");

/**
 * Sattori フェーズ1のインフラ一式。
 * 録画基盤(S3/CloudFront/ECR/EC2 Spot)＋ サーバーレス API(Lambda/API Gateway/DynamoDB)。
 * EC2 Spot の起動はここでは行わず、API Lambda が実行時に AWS SDK で起動する
 * (terraform-provider-aws の Spot ハング問題を避ける方針, PoC reports/16)。
 */
export class SattoriStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Web/メールで共通して使うカスタムドメイン。CloudFront(WebCdn)とSES送信元アドレス
    // (no-reply@<このドメイン>)の両方で使うため、コンストラクタ先頭で定義しておく。
    const webDomainName = "sattori.hakatashi.com";

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

    // --- メール送信(SES, マジックリンク認証 Issue #9) -----------------------
    // webDomainName配下から送信する(no-reply@<webDomainName>)。DKIM用のCNAMEは
    // ACM証明書のDNS検証と同様、`cdk deploy`実行後にCfnOutputの値を外部DNSへ
    // 手動追加する必要がある。また実際にサンドボックス外へ送信するには、別途
    // AWSへサンドボックス解除を申請する必要がある(コードでは自動化できない)。
    const sesFromAddress = `no-reply@${webDomainName}`;
    const sesIdentity = new ses.EmailIdentity(this, "SesIdentity", {
      identity: ses.Identity.domain(webDomainName),
    });

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
    // maxAzs は us-east-1 の全AZ数(a-fの6つ)に合わせている。EC2 Fleet の起動時に
    // 全AZへスポットリクエストを送ることで、単一AZでのキャパシティ枯渇
    // (InsufficientInstanceCapacity)への耐性を高める(NATを使わないため
    // AZ追加によるコスト増はない)。
    //
    // AZの構成自体（maxAzs）は変更しない。当初は us-east-1e を availabilityZones の
    // 明示指定で除外する案を試したが、既存サブネット(index5)のAZ・CIDRを差し替える
    // 形の更新になり、CloudFormationが新サブネット作成を旧サブネット削除より先に
    // 試みるため同一CIDR('10.0.4.0/24')の重複でデプロイが失敗した(create-before-delete
    // の既定挙動とCIDR一意制約が噛み合わない)。VPC自体は変更せず、下記
    // WORKER_SUBNET_IDS の組み立て時にus-east-1eのサブネットを除外することで
    // 同じ目的を安全に達成する（Issue #29）。
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

    // us-east-1e はこのAWSアカウントではレガシーAZ(AZ ID `use1-az3`)で、
    // c3/c4/d2/i2/i3/m3等の旧世代インスタンスファミリしか提供しておらず、
    // `apps/api/src/ec2.ts` の CANDIDATE_INSTANCE_TYPES
    // (c7i/c7a/c6a/c6i/c7i-flex/c5aのいずれのxlarge)も1つも存在しない
    // （`describe-instance-type-offerings`で確認済み）。含めても EC2 Fleet の
    // Overrides内で常に容量ゼロな組み合わせが増えるだけなので、
    // WORKER_SUBNET_IDS の組み立て時に除外する（Issue #29）。VPC自体
    // (maxAzs:6)は変更しない点に注意（上記コメント参照）。
    const workerSubnets = vpc.publicSubnets.filter(
      (subnet) => subnet.availabilityZone !== "us-east-1e",
    );

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
      SES_FROM_ADDRESS: sesFromAddress,
      WEB_BASE_URL: `https://${webDomainName}`,
    };

    // `environment`省略時は`commonEnv`を使う。管理画面のauthorizer(Issue #51)のように
    // `commonEnv`とは無関係な環境変数だけを持たせたいLambdaのために上書きできるようにする。
    const makeHandler = (name: string, entry: string, environment: Record<string, string> = commonEnv) =>
      new NodejsFunction(this, name, {
        entry: join(API_HANDLERS, entry),
        handler: "handler",
        runtime: lambda.Runtime.NODEJS_22_X,
        timeout: Duration.seconds(30),
        environment,
        bundling: {
          // CJS で出力する。ESM 出力だと AWS SDK 内部の動的 require("node:https")
          // が Lambda(ESM) で "Dynamic require not supported" となり失敗するため。
          // @sattori/shared(ワークスペース依存)を含めてすべてバンドルする。
          externalModules: [],
        },
      });

    const createUploadFn = makeHandler("CreateUploadFn", "createUpload.ts");
    const parseReplayFn = makeHandler("ParseReplayFn", "parseReplay.ts");
    const getJobFn = makeHandler("GetJobFn", "getJob.ts");
    const requestMagicLinkFn = makeHandler("RequestMagicLinkFn", "requestMagicLink.ts");

    // 権限付与
    uploadBucket.grantPut(createUploadFn); // 署名付き PUT URL 発行のため
    uploadBucket.grantRead(parseReplayFn); // アップロード済み .rpy を取得して解析するため
    jobsTable.grantReadData(getJobFn);

    // マジックリンクの送信要求は、status:pending の JobRecord 作成(jobsTable書き込み)、
    // レート制限カウンタの読み書き、SESでの送信権限が必要。
    jobsTable.grantReadWriteData(requestMagicLinkFn);
    emailRateLimitTable.grantReadWriteData(requestMagicLinkFn);
    // SESアカウントがサンドボックス中は、送信元IDだけでなく送信先(受信者)の
    // メールアドレスも「検証済みID」としてIAMの権限チェック対象になる
    // (受信者ごとに個別の identity ARN が動的に検査される)。宛先はユーザー入力の
    // 任意アドレスでデプロイ時に特定できないため、Resourceはこのアカウント配下の
    // SES identity 全体(送信元ドメイン・任意の受信者アドレスの両方を含む)に絞る。
    // サンドボックス解除後は受信者側のチェックは行われなくなるが、Resourceを
    // 変更する必要はない。
    requestMagicLinkFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ses:SendEmail"],
        resources: [`arn:aws:ses:${this.region}:${this.account}:identity/*`],
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
        resources: [`arn:aws:ses:${this.region}:${this.account}:identity/*`],
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

    const launchFn = makeHandler("LaunchFn", "sfn/launch.ts");
    const handleFailureFn = makeHandler("HandleFailureFn", "sfn/handleFailure.ts");

    jobsTable.grantReadWriteData(launchFn);
    // launchFn は EC2 Fleet を起動し、ワーカーロールを PassRole する。
    launchFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "ec2:CreateFleet",
          "ec2:CreateLaunchTemplateVersion",
          "ec2:RunInstances",
          "ec2:CreateTags",
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
        actions: ["ec2:TerminateInstances"],
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
      // 録画ジョブ全体のフェイルセーフタイムアウト。90分を超えてもワーカーから
      // taskTokenの応答が無ければ強制的に失敗させ、HandleFailureで後始末する。
      // 録画自体のタイムアウト(recording_common.TIMEOUT_SEC=60分)に、720pアップスケール
      // 変換・S3アップロード・DynamoDB更新・taskToken通知の分の余裕(30分)を上乗せしている。
      taskTimeout: sfn.Timeout.duration(Duration.minutes(90)),
      resultPath: sfn.JsonPath.DISCARD,
    });

    const handleFailureTask = new tasks.LambdaInvoke(this, "HandleFailure", {
      lambdaFunction: handleFailureFn,
      payload: sfn.TaskInput.fromObject({
        jobId: sfn.JsonPath.stringAt("$.jobId"),
        attempt: sfn.JsonPath.numberAt("$.attempt"),
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
    // STATE_MACHINE_ARN は startJobFn だけに付与する(commonEnv には含めない)。
    // ステートマシンは launchFn/handleFailureFn を呼び出す(Lambda ARN に依存)ため、
    // それらの環境変数がステートマシンARNを参照すると CloudFormation の循環依存になる。
    startJobFn.addEnvironment("STATE_MACHINE_ARN", stateMachine.stateMachineArn);

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

    // --- 静的フロントエンド(S3 + CloudFront) ------------------------------

    const webBucket = new s3.Bucket(this, "WebBucket", {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // カスタムドメイン用証明書。CloudFront にアタッチする証明書は us-east-1 必須
    // (このスタック自体が既定で us-east-1 なので同一スタック内で作成できる)。
    // hakatashi.com は Route 53 以外の DNS で管理しているため、hostedZone による
    // 自動検証はできない。DNS 検証用 CNAME は `cdk deploy` 実行中に ACM コンソール
    // (us-east-1)で確認し、外部 DNS へ手動追加する。
    const webCertificate = new acm.Certificate(this, "WebCertificate", {
      domainName: webDomainName,
      validation: acm.CertificateValidation.fromDns(),
    });

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

    // --- 出力 --------------------------------------------------------------

    new CfnOutput(this, "ApiUrl", { value: httpApi.apiEndpoint });
    new CfnOutput(this, "WebUrl", { value: `https://${webDomainName}` });
    // 外部 DNS 側で `sattori` を CNAME としてこのドメインへ向ける。
    new CfnOutput(this, "WebCdnDomain", { value: webDistribution.distributionDomainName });
    new CfnOutput(this, "MediaCdnDomain", { value: mediaDistribution.distributionDomainName });
    new CfnOutput(this, "WorkerRepoUri", { value: workerRepo.repositoryUri });
    // タイトル資産アップロード先(worker/README.md「タイトル資産のS3アップロード手順」参照)。
    new CfnOutput(this, "TitleAssetsBucketName", { value: titleAssetsBucket.bucketName });
    // ACM証明書のDNS検証と同様、SESのDKIM用CNAMEも外部DNSへ手動追加が必要
    // (`cdk deploy` 完了後にこの出力を確認して追加する)。
    sesIdentity.dkimRecords.forEach((record, index) => {
      new CfnOutput(this, `SesDkimRecord${index}`, {
        value: `${record.name} CNAME ${record.value}`,
      });
    });
  }
}
