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
  // trap EXIT で必ず shutdown する（Spot 終了 = 課金停止）。ECR ログインや
  // docker 実行が失敗しても、インスタンスを起動したまま残さない（孤児防止）。
  // set -e は付けない（途中失敗でも trap を通って確実に停止させるため）。
  const script = `#!/bin/bash
export AWS_DEFAULT_REGION=${config.ec2.region}
trap 'shutdown -h now' EXIT
# ECS 最適化 AMI は docker を含むが、プレーンな docker ホストとして使う。常駐する
# ECS エージェントが 4vCPU を消費し、高負荷区間(弾幕)で ffmpeg の x11grab キャプチャと
# CPU コンテンションを起こしてフレーム取りこぼし(処理落ち)を増やすため停止する。
# 検証: 八雲藍(Extra ボス)戦の重複フレーム率が 15-26%(有効時) → 4.8%(停止時) に改善。
systemctl disable --now ecs >/dev/null 2>&1 || true
# プレーンな docker ホストとして使うため docker のみ明示起動。
systemctl enable --now docker >/dev/null 2>&1 || service docker start >/dev/null 2>&1 || true
# aws CLI が無い環境向けのフォールバック導入。
command -v aws >/dev/null 2>&1 || dnf install -y awscli >/dev/null 2>&1 || dnf install -y aws-cli >/dev/null 2>&1 || true
aws ecr get-login-password --region ${config.ec2.region} | docker login --username AWS --password-stdin ${registry}
docker run --rm \\
  --log-driver awslogs \\
  --log-opt awslogs-region=${config.ec2.region} \\
  --log-opt awslogs-group=${config.logGroup} \\
  --log-opt awslogs-stream=${job.jobId} \\
  -e AWS_DEFAULT_REGION=${config.ec2.region} \\
  -e AWS_REGION=${config.ec2.region} \\
  -e JOB_ID=${job.jobId} \\
  -e GAME=${job.game} \\
  -e REPLAY_BUCKET=${config.uploadBucket} \\
  -e REPLAY_KEY=${job.replayKey} \\
  -e OUTPUT_BUCKET=${config.outputBucket} \\
  -e JOBS_TABLE=${config.jobsTable} \\
  -e WATERMARK=${job.options.watermark ? "1" : "0"} \\
  ${config.workerImage}
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
