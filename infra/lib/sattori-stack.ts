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
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as apigw from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
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

    // --- ストレージ ---------------------------------------------------------

    // アップロードされた .rpy を一時保管するバケット(1日で自動削除)。
    const uploadBucket = new s3.Bucket(this, "UploadBucket", {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      lifecycleRules: [{ expiration: Duration.days(1) }],
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
    });

    // --- 録画ワーカー(ECR / VPC / IAM) -------------------------------------

    const workerRepo = new ecr.Repository(this, "WorkerRepo", {
      repositoryName: "sattori-worker",
      removalPolicy: RemovalPolicy.DESTROY,
      emptyOnDelete: true,
      lifecycleRules: [{ maxImageCount: 5 }],
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

    // ワーカー EC2 に付与するロール。ECR pull・リプレイ取得・動画出力・状態更新。
    const workerRole = new iam.Role(this, "WorkerRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
    });
    uploadBucket.grantRead(workerRole);
    outputBucket.grantWrite(workerRole);
    jobsTable.grantReadWriteData(workerRole);
    workerRepo.grantPull(workerRole);

    const workerInstanceProfile = new iam.InstanceProfile(this, "WorkerInstanceProfile", {
      role: workerRole,
    });

    // Docker 同梱の ECS 最適化 AL2023 AMI を利用(UserData で docker run するだけ)。
    const workerAmiId = ssm.StringParameter.valueForStringParameter(
      this,
      "/aws/service/ecs/optimized-ami/amazon-linux-2023/recommended/image_id",
    );

    // --- API(Lambda + HTTP API) -------------------------------------------

    const commonEnv: Record<string, string> = {
      UPLOAD_BUCKET: uploadBucket.bucketName,
      OUTPUT_BUCKET: outputBucket.bucketName,
      CDN_DOMAIN: mediaDistribution.distributionDomainName,
      JOBS_TABLE: jobsTable.tableName,
      WORKER_IMAGE: `${workerRepo.repositoryUri}:latest`,
      WORKER_AMI_ID: workerAmiId,
      WORKER_SUBNET_ID: vpc.publicSubnets[0]!.subnetId,
      WORKER_INSTANCE_PROFILE_ARN: workerInstanceProfile.instanceProfileArn,
      WORKER_SECURITY_GROUP_ID: workerSg.securityGroupId,
      WORKER_INSTANCE_TYPE: "c7i.xlarge",
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
    const createJobFn = makeHandler("CreateJobFn", "createJob.ts");
    const getJobFn = makeHandler("GetJobFn", "getJob.ts");

    // 権限付与
    uploadBucket.grantPut(createUploadFn); // 署名付き PUT URL 発行のため
    jobsTable.grantReadWriteData(createJobFn);
    jobsTable.grantReadData(getJobFn);

    // createJob は EC2 Spot を起動し、ワーカーロールを PassRole する。
    createJobFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ec2:RunInstances", "ec2:CreateTags"],
        resources: ["*"],
      }),
    );
    createJobFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["iam:PassRole"],
        resources: [workerRole.roleArn],
      }),
    );

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
      path: "/jobs",
      methods: [apigw.HttpMethod.POST],
      integration: new HttpLambdaIntegration("CreateJobInt", createJobFn),
    });
    httpApi.addRoutes({
      path: "/jobs/{jobId}",
      methods: [apigw.HttpMethod.GET],
      integration: new HttpLambdaIntegration("GetJobInt", getJobFn),
    });

    // --- 静的フロントエンド(S3 + CloudFront) ------------------------------

    const webBucket = new s3.Bucket(this, "WebBucket", {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    const webDistribution = new cloudfront.Distribution(this, "WebCdn", {
      defaultRootObject: "index.html",
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
    new CfnOutput(this, "WebUrl", { value: `https://${webDistribution.distributionDomainName}` });
    new CfnOutput(this, "MediaCdnDomain", { value: mediaDistribution.distributionDomainName });
    new CfnOutput(this, "WorkerRepoUri", { value: workerRepo.repositoryUri });
  }
}
