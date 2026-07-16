import { RunInstancesCommand, EC2Client } from "@aws-sdk/client-ec2";
import type { JobRecord } from "@sattori/shared";
import type { ApiConfig } from "./config.js";

const ec2 = new EC2Client({});

/**
 * ワーカーインスタンスの UserData（cloud-init）スクリプトを生成する。
 * ECR ログイン → 録画ワーカーコンテナ実行 → 完了後に自動シャットダウン（=Spot終了）。
 * ジョブ固有の値は環境変数でコンテナに渡す。ワーカー本体は S3/DynamoDB を直接更新する。
 *
 * 注: フェーズ1は単一 RunInstances（Spot）での最小起動。複数AZ Spot Fleet と
 * Step Functions によるリトライ制御はフェーズ2で導入する（reports/17 の知見）。
 */
export function buildUserData(config: ApiConfig, job: JobRecord): string {
  const registry = config.workerImage.split("/")[0] ?? "";
  const script = `#!/bin/bash
set -euo pipefail
export AWS_DEFAULT_REGION=${config.ec2.region}
aws ecr get-login-password --region ${config.ec2.region} | docker login --username AWS --password-stdin ${registry}
docker run --rm \\
  -e JOB_ID=${job.jobId} \\
  -e GAME=${job.game} \\
  -e REPLAY_BUCKET=${config.uploadBucket} \\
  -e REPLAY_KEY=${job.replayKey} \\
  -e OUTPUT_BUCKET=${config.outputBucket} \\
  -e JOBS_TABLE=${config.jobsTable} \\
  -e WATERMARK=${job.options.watermark ? "1" : "0"} \\
  ${config.workerImage}
shutdown -h now
`;
  return Buffer.from(script, "utf-8").toString("base64");
}

/** Spot インスタンスを1台起動して録画ジョブを実行する。起動したインスタンスIDを返す。 */
export async function launchRecordingInstance(
  config: ApiConfig,
  job: JobRecord,
): Promise<string> {
  const result = await ec2.send(
    new RunInstancesCommand({
      ImageId: config.ec2.amiId,
      InstanceType: config.ec2.instanceType as never,
      MinCount: 1,
      MaxCount: 1,
      SubnetId: config.ec2.subnetId,
      SecurityGroupIds: [config.ec2.securityGroupId],
      IamInstanceProfile: { Arn: config.ec2.instanceProfileArn },
      UserData: buildUserData(config, job),
      InstanceInitiatedShutdownBehavior: "terminate",
      InstanceMarketOptions: {
        MarketType: "spot",
        SpotOptions: { SpotInstanceType: "one-time" },
      },
      TagSpecifications: [
        {
          ResourceType: "instance",
          Tags: [
            { Key: "Name", Value: "sattori-recorder" },
            { Key: "sattori:jobId", Value: job.jobId },
          ],
        },
      ],
    }),
  );
  const instanceId = result.Instances?.[0]?.InstanceId;
  if (!instanceId) {
    throw new Error("EC2 インスタンスの起動に失敗しました（InstanceId 不明）");
  }
  return instanceId;
}
