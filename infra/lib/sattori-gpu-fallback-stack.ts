import { Duration, RemovalPolicy, Stack, Tags, type StackProps } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import { OUTPUT_RETENTION_DAYS } from "@sattori/shared";
import type { Construct } from "constructs";
import {
  GPU_FALLBACK_AVAILABILITY_ZONES,
  GPU_FALLBACK_LAUNCH_TEMPLATE_NAME,
  GPU_FALLBACK_SUBNET_TAG_KEY,
  GPU_WORKER_REMOTE_INSTANCE_PROFILE_NAME,
  GPU_WORKER_REPOSITORY_NAME,
  gpuFallbackOutputBucketName,
  gpuFallbackTitleAssetsBucketName,
  gpuWorkerAmiIdFor,
} from "./gpu-fallback.ts";

/**
 * GPUワーカーの容量不足時フォールバック先（eu-north-1、Issue #296）。
 *
 * eu-south-2のg6f.2xlarge Spotが枯渇したときだけ、Launch Lambdaがここへ`CreateFleet`する
 * （`apps/api/src/ec2.ts`、`docs/decisions/0061`）。置くのはEC2の起動に必要な最小限と、
 * リージョン間転送料を消すための2つのバケットだけ（Issue #313、`docs/decisions/0062`）。
 * DynamoDB・Step Functions・ログ・リプレイは一次リージョンのまま。
 *
 * - VPC: パブリックサブネットのみ・NATなし（本体の`WorkerVpc`と同じ最小構成）。
 *   g6f.2xlargeを提供する2AZ（`GPU_FALLBACK_AVAILABILITY_ZONES`）に限定する。
 * - GPU Launch Template: 固定名。AMIは本体のGPU AMIを`copy-image`したもの。
 * - 出力バケット: ここで動くワーカーの出力（チェックポイント・動画・プレビュー画像）の置き場。
 *   本体の MediaCdn が `/eu-north-1/*` から OAC で配信する。
 * - タイトル資産のレプリカ: 本体の TitleAssetsBucket から S3 レプリケーションで複製する受け皿。
 * - ECRリポジトリ: 本体のGPUイメージのレプリケーション先（受け皿）。本体の
 *   レジストリ複製設定より**先に**作っておく（複製が先に走るとECRが同名の
 *   リポジトリをライフサイクル無しで自動作成し、このスタックの作成が衝突するため）。
 *   デプロイ順はフォールバック → 本体（`bin/sattori.ts`）。
 *
 * 本体スタックとの間にCloudFormationの参照は張らない（`gpu-fallback.ts`参照）。
 */
export class SattoriGpuFallbackStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, "GpuWorkerVpc", {
      availabilityZones: GPU_FALLBACK_AVAILABILITY_ZONES,
      natGateways: 0,
      subnetConfiguration: [
        { name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
      ],
    });
    // Launch Lambdaはこのタグでサブネットを実行時に引く（本体へサブネットIDを
    // クロスリージョン参照で渡さないため）。
    for (const subnet of vpc.publicSubnets) {
      Tags.of(subnet).add(GPU_FALLBACK_SUBNET_TAG_KEY, "true");
    }
    // 同じリージョンのS3（出力バケット・タイトル資産レプリカ）への通信をVPC内で閉じる。
    // Gateway Endpointは無料で、パブリックIP経由でも同一リージョンのS3転送は無料だが、
    // 経路を明示しておく（Issue #313）。
    vpc.addGatewayEndpoint("S3Endpoint", { service: ec2.GatewayVpcEndpointAwsService.S3 });

    // ここで動くワーカーの出力（Issue #313）。本体の`OutputBucket`と同じライフサイクルにする
    // （`infra/lib/sattori-stack.ts`。ダウンロード期限の表示が`OUTPUT_RETENTION_DAYS`に依存するため）。
    const outputBucket = new s3.Bucket(this, "OutputBucket", {
      bucketName: gpuFallbackOutputBucketName(this.account),
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      lifecycleRules: [
        { expiration: Duration.days(OUTPUT_RETENTION_DAYS) },
        { prefix: "worker-logs/", expiration: Duration.days(3) },
      ],
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    // 本体の MediaCdn（OAC）からの読み取りを許可する。distributionのARNは本体スタックにしか
    // 無く、スタック間参照は張らない（デプロイ順はこのスタックが先）ため、このアカウントの
    // CloudFront distributionに絞る。アカウント内で配信に使うdistributionはMediaCdnとWebCdnだけで、
    // WebCdnにこのバケットのオリジンは無い。
    outputBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject"],
        principals: [new iam.ServicePrincipal("cloudfront.amazonaws.com")],
        resources: [outputBucket.arnForObjects("*")],
        conditions: {
          StringLike: { "AWS:SourceArn": `arn:aws:cloudfront::${this.account}:distribution/*` },
        },
      }),
    );

    // タイトル資産のレプリカ（Issue #313）。本体のTitleAssetsBucketがS3レプリケーションで書き込む
    // （レプリケーションの設定・ロールは本体側）。レプリケーションは宛先にもバージョニングを要する。
    // 旧バージョンは本体側に90日残るので、ここではすぐ消す。本体と違いRETAINにしないのは、
    // 中身がいつでも本体から複製し直せる写しだから。
    new s3.Bucket(this, "TitleAssetsReplicaBucket", {
      bucketName: gpuFallbackTitleAssetsBucketName(this.account),
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: true,
      lifecycleRules: [{ noncurrentVersionExpiration: Duration.days(1) }],
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const workerSg = new ec2.SecurityGroup(this, "GpuWorkerSg", {
      vpc,
      description: "Sattori GPU recording worker in fallback region (egress only)",
      allowAllOutbound: true,
    });

    new ec2.CfnLaunchTemplate(this, "GpuWorkerLaunchTemplate", {
      launchTemplateName: GPU_FALLBACK_LAUNCH_TEMPLATE_NAME,
      launchTemplateData: {
        imageId: gpuWorkerAmiIdFor(this.node.tryGetContext("gpuWorkerAmiIds"), this.region),
        instanceType: "g6f.2xlarge",
        // 本体スタックが作る固定名のインスタンスプロファイル（`WorkerRole`を共有）。
        // Launch Templateの作成時点では存在を検証されない（EC2の仕様）ため、
        // このスタックを本体より先にデプロイしても作成は通る。
        iamInstanceProfile: { name: GPU_WORKER_REMOTE_INSTANCE_PROFILE_NAME },
        securityGroupIds: [workerSg.securityGroupId],
        instanceInitiatedShutdownBehavior: "terminate",
        userData: Buffer.from("#!/bin/bash\nexit 0\n", "utf-8").toString("base64"),
      },
    });

    new ecr.Repository(this, "WorkerGpuRepoReplica", {
      repositoryName: GPU_WORKER_REPOSITORY_NAME,
      removalPolicy: RemovalPolicy.DESTROY,
      emptyOnDelete: true,
      // 本体と同じ世代数（ロールバック用に1世代前を残す）。
      lifecycleRules: [{ maxImageCount: 2 }],
    });
  }
}
