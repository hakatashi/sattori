import {
  CreateFleetCommand,
  CreateLaunchTemplateVersionCommand,
  EC2Client,
  TerminateInstancesCommand,
} from "@aws-sdk/client-ec2";
import type { JobRecord } from "@sattori/shared";
import type { ApiConfig } from "./config.js";

const ec2 = new EC2Client({});

/**
 * ワーカーインスタンスの UserData（cloud-init）スクリプトを生成する。
 * ECR ログイン → 録画ワーカーコンテナ実行 → 完了後に自動シャットダウン（=Spot終了）。
 * ジョブ固有の値は環境変数でコンテナに渡す。ワーカー本体は S3/DynamoDB を直接更新する。
 *
 * `taskToken` は Step Functions の `waitForTaskToken` パターンのトークン。ワーカーが
 * 録画/変換の成功・失敗を `SendTaskSuccess`/`SendTaskFailure` で直接通知するために渡す。
 */
export function buildUserData(config: ApiConfig, job: JobRecord, taskToken: string): string {
  const registry = config.workerImage.split("/")[0] ?? "";

  const envFlags = [
    `-e AWS_DEFAULT_REGION=${config.ec2.region}`,
    `-e AWS_REGION=${config.ec2.region}`,
    `-e JOB_ID=${job.jobId}`,
    `-e GAME=${job.game}`,
    `-e REPLAY_BUCKET=${config.uploadBucket}`,
    `-e REPLAY_KEY=${job.replayKey}`,
    `-e OUTPUT_BUCKET=${config.outputBucket}`,
    `-e JOBS_TABLE=${config.jobsTable}`,
    `-e WATERMARK=${job.options.watermark ? "1" : "0"}`,
    // taskToken は Step Functions が発行する不透明な文字列（AWS生成、ユーザー入力ではない）。
    // シェル展開を避けるためシングルクォートで囲む。
    `-e TASK_TOKEN='${taskToken}'`,
  ];
  if (job.estimatedDurationSeconds !== null) {
    // ワーカーの録画進捗率算出用の参考値（取得できていなければ付与しない）。
    envFlags.push(`-e EXPECTED_DURATION_SECONDS=${job.estimatedDurationSeconds}`);
  }

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
  ${envFlags.join(" \\\n  ")} \\
  ${config.workerImage}
`;
  return Buffer.from(script, "utf-8").toString("base64");
}

/**
 * EC2 Fleet でワーカーインスタンスを1台起動して録画ジョブを実行する。
 * 起動したインスタンスIDを返す。
 *
 * ベースの Launch Template（AMI/インスタンスタイプ/IAM/SGはCDK側で設定済み）に対し、
 * ジョブ固有の UserData のみを持つ新しいバージョンを作成し、そのバージョンを参照する
 * `CreateFleet`（`Type: "instant"`）で即時に1台起動する。複数サブネット（=複数AZ）を
 * Overrides に渡し `lowest-price` 戦略で配置することで、単一AZでのSpot枯渇に対する
 * 耐性を持たせる（PoC reports/17）。
 */
export async function launchRecordingInstance(
  config: ApiConfig,
  job: JobRecord,
  taskToken: string,
): Promise<string> {
  const userData = buildUserData(config, job, taskToken);

  const version = await ec2.send(
    new CreateLaunchTemplateVersionCommand({
      LaunchTemplateId: config.ec2.launchTemplateId,
      SourceVersion: "$Default",
      LaunchTemplateData: { UserData: userData },
    }),
  );
  const versionNumber = version.LaunchTemplateVersion?.VersionNumber;
  if (versionNumber === undefined) {
    throw new Error("Launch Template バージョンの作成に失敗しました（VersionNumber 不明）");
  }

  const result = await ec2.send(
    new CreateFleetCommand({
      Type: "instant",
      LaunchTemplateConfigs: [
        {
          LaunchTemplateSpecification: {
            LaunchTemplateId: config.ec2.launchTemplateId,
            Version: String(versionNumber),
          },
          Overrides: config.ec2.subnetIds.map((subnetId) => ({ SubnetId: subnetId })),
        },
      ],
      TargetCapacitySpecification: {
        TotalTargetCapacity: 1,
        DefaultTargetCapacityType: "spot",
      },
      SpotOptions: {
        AllocationStrategy: "lowest-price",
        SingleInstanceType: true,
        SingleAvailabilityZone: false,
        InstanceInterruptionBehavior: "terminate",
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

  const instanceId = result.Instances?.[0]?.InstanceIds?.[0];
  if (!instanceId) {
    const reason = result.Errors?.map((e) => `${e.ErrorCode}: ${e.ErrorMessage}`).join("; ");
    throw new Error(
      `EC2 Fleet でのインスタンス起動に失敗しました（InstanceId 不明）${reason ? `: ${reason}` : ""}`,
    );
  }
  return instanceId;
}

/**
 * ジョブ失敗（Spot中断・タイムアウト等）時に、孤児化した可能性のあるインスタンスを
 * terminate する。既に終了済み・存在しない場合も冪等に成功扱いとする
 * （リトライの度に毎回呼ばれるため）。
 */
export async function terminateInstance(instanceId: string): Promise<void> {
  try {
    await ec2.send(new TerminateInstancesCommand({ InstanceIds: [instanceId] }));
  } catch (err) {
    const name = err instanceof Error ? err.name : undefined;
    if (name === "InvalidInstanceID.NotFound") {
      return;
    }
    throw err;
  }
}
