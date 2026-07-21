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
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import * as tasks from "aws-cdk-lib/aws-stepfunctions-tasks";
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

    // 録画済み動画の出力バケット(7日で自動削除, CloudFront オリジン)。
    const outputBucket = new s3.Bucket(this, "OutputBucket", {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      lifecycleRules: [{ expiration: Duration.days(7) }],
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // 動画配信用 CloudFront(OAC 経由の非公開配信, 無料枠でegress実質ゼロ)。
    const mediaDistribution = new cloudfront.Distribution(this, "MediaCdn", {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(outputBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
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
    const vpc = new ec2.Vpc(this, "WorkerVpc", {
      maxAzs: 2,
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

    const commonEnv: Record<string, string> = {
      UPLOAD_BUCKET: uploadBucket.bucketName,
      OUTPUT_BUCKET: outputBucket.bucketName,
      CDN_DOMAIN: mediaDistribution.distributionDomainName,
      JOBS_TABLE: jobsTable.tableName,
      WORKER_IMAGE: `${workerRepo.repositoryUri}:latest`,
      TITLE_ASSETS_BUCKET: titleAssetsBucket.bucketName,
      WORKER_LOG_GROUP: workerLogGroup.logGroupName,
      WORKER_SUBNET_IDS: vpc.publicSubnets.map((subnet) => subnet.subnetId).join(","),
      WORKER_LAUNCH_TEMPLATE_ID: workerLaunchTemplate.ref,
      EMAIL_RATE_LIMIT_TABLE: emailRateLimitTable.tableName,
      SES_FROM_ADDRESS: sesFromAddress,
      WEB_BASE_URL: `https://${webDomainName}`,
    };

    const makeHandler = (name: string, entry: string) =>
      new NodejsFunction(this, name, {
        entry: join(API_HANDLERS, entry),
        handler: "handler",
        runtime: lambda.Runtime.NODEJS_22_X,
        timeout: Duration.seconds(30),
        environment: commonEnv,
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
      // 録画ジョブ全体のフェイルセーフタイムアウト。60分を超えてもワーカーから
      // taskTokenの応答が無ければ強制的に失敗させ、HandleFailureで後始末する。
      taskTimeout: sfn.Timeout.duration(Duration.minutes(60)),
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

    const httpApi = new apigw.HttpApi(this, "HttpApi", {
      corsPreflight: {
        allowOrigins: ["*"],
        allowMethods: [apigw.CorsHttpMethod.GET, apigw.CorsHttpMethod.POST],
        allowHeaders: ["content-type"],
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

    const webDistribution = new cloudfront.Distribution(this, "WebCdn", {
      defaultRootObject: "index.html",
      domainNames: [webDomainName],
      certificate: webCertificate,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(webBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      // SPA: 未知パスは index.html にフォールバック。
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: "/index.html" },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: "/index.html" },
      ],
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
