import { RemovalPolicy, Stack, Tags, type StackProps } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import type { Construct } from "constructs";
import {
  GPU_FALLBACK_AVAILABILITY_ZONES,
  GPU_FALLBACK_LAUNCH_TEMPLATE_NAME,
  GPU_FALLBACK_SUBNET_TAG_KEY,
  GPU_WORKER_REMOTE_INSTANCE_PROFILE_NAME,
  GPU_WORKER_REPOSITORY_NAME,
  gpuWorkerAmiIdFor,
} from "./gpu-fallback.ts";

/**
 * GPUワーカーの容量不足時フォールバック先（eu-north-1、Issue #296）。
 *
 * eu-south-2のg6f.2xlarge Spotが枯渇したときだけ、Launch Lambdaがここへ`CreateFleet`する
 * （`apps/api/src/ec2.ts`、`docs/decisions/0061`）。**置くのはEC2の起動に必要な最小限だけ**
 * で、データ面（S3・DynamoDB・Step Functions・ログ）は一切持たない——ワーカーは
 * eu-south-2の資源を直接読み書きする（リージョン間転送料は管理画面のコスト推定に計上）。
 *
 * - VPC: パブリックサブネットのみ・NATなし（本体の`WorkerVpc`と同じ最小構成）。
 *   g6f.2xlargeを提供する2AZ（`GPU_FALLBACK_AVAILABILITY_ZONES`）に限定する。
 * - GPU Launch Template: 固定名。AMIは本体のGPU AMIを`copy-image`したもの。
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
