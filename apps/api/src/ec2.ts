import {
  CreateFleetCommand,
  CreateLaunchTemplateVersionCommand,
  DescribeInstancesCommand,
  DescribeSpotPriceHistoryCommand,
  EC2Client,
  type _InstanceType as InstanceType,
  TerminateInstancesCommand,
} from "@aws-sdk/client-ec2";
import type { JobRecord } from "@sattori/shared";
import type { ApiConfig } from "./config.js";

const ec2 = new EC2Client({});

/** インスタンスに付与しているジョブ識別用のタグキー（`buildCreateFleetInput`と対で使う）。 */
export const JOB_ID_TAG_KEY = "sattori:jobId";

/**
 * Spot Fleet に含める候補インスタンスタイプ（th11以外）。`c7i.xlarge` 単独だと、
 * そのハードウェアプールが時間帯によって枯渇した際に `InsufficientInstanceCapacity`
 * で録画ジョブの起動自体が失敗する（Issue #29）。インスタンスタイプごとに独立した
 * Spotキャパシティプールを持つため、AZ分散よりも大きな改善効果が見込める。
 *
 * ただしインスタンスタイプの変更は録画品質（Wine+Xvfb+ffmpegの重複フレーム率）に
 * 直結するリスクがあり、「同スペック帯・同価格帯だから安全」とは限らない
 * （`z1d.xlarge` は高クロック特化ゆえに悪化した実績がある、AGENTS.md参照）。
 * さらにリージョンが変わればハードウェア世代も変わりうるため、あるリージョンでの
 * 実機検証結果を無条件に他リージョンへ適用してはいけない。
 *
 * リージョンをeu-south-2(スペイン)へ移設(2026-08)したことに伴い、旧us-east-1で
 * 使っていた`c6a`/`c6i`/`c5a`系は削除した(eu-south-2に存在しない、
 * `describe-instance-type-offerings`で確認済み)。以下4タイプはすべてeu-south-2実機で
 * 検証済み（touhou-recorder reports/42・43）。
 *
 * 【重要】reports/43で、これとは別にth08（および恐らくth07）のリプレイ終了検知
 * テンプレート画像がタイトルバー分ずれており、テンプレート照合が機能しない
 * （インスタンスタイプによらず全タイプで発生）既存バグが見つかった。このバグは
 * インスタンスタイプ選定とは無関係だが、修正されるまではth08/th07のジョブが
 * TIMEOUT_SEC（`recording_common.py`）到達まで録画し続け、動画末尾に静止画面が
 * 付く形で完了する可能性がある。`worker/assets/replay_end_templates/th08.png`・
 * `th07.png`がこの問題を抱えていないか確認・修正することを推奨する（詳細は
 * touhou-recorder reports/43参照）。
 */
const DEFAULT_CANDIDATE_INSTANCE_TYPES: InstanceType[] = [
  "c7i.xlarge", // Intel Sapphire Rapids。reports/42実測で重複フレーム率0.1〜0.2%、第一候補
  "c7a.xlarge", // AMD Genoa。reports/43実測で重複フレーム率1.4%（実ゲームプレイ区間）
  "c7i-flex.xlarge", // Intel現行世代のburstableオプション。reports/43実測で重複フレーム率5.0%（同上）
  "m7i.xlarge", // Intel Sapphire Rapids(メモリ倍増版)。reports/43実測で重複フレーム率2.7%（同上）
];

/**
 * th11専用の候補インスタンスタイプ。`.xlarge`帯(4vCPU)では本番で深刻な処理落ち
 * （ゲーム内fps表示が最悪35fps程度まで低下する、コマ落ちではなくゲームプレイ自体の
 * 実時間伸長）が発生した。touhou-recorder `reports/40` の実機検証で、原因は
 * CPU世代ではなくvCPU数の不足であることが判明し、8vCPU/16GiB以上(`.2xlarge`帯)に
 * すると重複フレーム率が明確に改善することを確認した。th06/07/08向けの
 * `DEFAULT_CANDIDATE_INSTANCE_TYPES`とはインスタンスタイプの重なりがない別リストとして
 * 管理する。
 *
 * eu-south-2には`c6i`/`c6a`系が存在しないため、旧リストの`c6i.2xlarge`/`c6a.2xlarge`は
 * 削除した。以下3タイプはすべてeu-south-2実機で検証済み（touhou-recorder
 * reports/42・43）で、いずれも想定尺どおりの自然終了・良好な重複フレーム率を確認済み。
 */
const TH11_CANDIDATE_INSTANCE_TYPES: InstanceType[] = [
  "c7i.2xlarge", // Intel Sapphire Rapids。reports/42実測で重複フレーム率4.5%、第一候補
  "c7a.2xlarge", // AMD Genoa。reports/43実測で重複フレーム率0.4%
  "m7i.2xlarge", // Intel Sapphire Rapids(メモリ倍増版)。reports/43実測で重複フレーム率3.7%
];

function getCandidateInstanceTypes(game: JobRecord["game"]): InstanceType[] {
  return game === "th11" ? TH11_CANDIDATE_INSTANCE_TYPES : DEFAULT_CANDIDATE_INSTANCE_TYPES;
}

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
    `-e TITLE_ASSETS_BUCKET=${config.titleAssetsBucket}`,
    `-e JOBS_TABLE=${config.jobsTable}`,
    `-e WATERMARK=${job.options.watermark ? "1" : "0"}`,
    // taskToken はスクリプト冒頭で $TASK_TOKEN に格納済み（bootstrap 失敗時の
    // SendTaskFailure 通知と共有するため）。ここでは二重埋め込みを避けそれを参照する。
    `-e TASK_TOKEN="$TASK_TOKEN"`,
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
TASK_TOKEN='${taskToken}'

# コンテナが一度も起動できないまま(ECR ログイン/pull 失敗等)shutdown すると、
# ワーカー内部(entrypoint.py)の taskToken 通知が一切実行されず、Step Functions が
# 60分タイムアウトするまでジョブが「起動中」のまま停滞する事故が発生したため、
# コンテナ起動前段階の失敗はここで即座に SendTaskFailure する。
notify_bootstrap_failure() {
  aws stepfunctions send-task-failure \\
    --task-token "$TASK_TOKEN" \\
    --error "WorkerBootstrapFailure" \\
    --cause "$1" >/dev/null 2>&1 || true
}

# ECS 最適化 AMI は docker を含むが、プレーンな docker ホストとして使う。常駐する
# ECS エージェントが 4vCPU を消費し、高負荷区間(弾幕)で ffmpeg の x11grab キャプチャと
# CPU コンテンションを起こしてフレーム取りこぼし(処理落ち)を増やすため停止する。
# 検証: 八雲藍(Extra ボス)戦の重複フレーム率が 15-26%(有効時) → 4.8%(停止時) に改善。
systemctl disable --now ecs >/dev/null 2>&1 || true
# プレーンな docker ホストとして使うため docker のみ明示起動。
systemctl enable --now docker >/dev/null 2>&1 || service docker start >/dev/null 2>&1 || true
# aws CLI が無い環境向けのフォールバック導入。
command -v aws >/dev/null 2>&1 || dnf install -y awscli >/dev/null 2>&1 || dnf install -y aws-cli >/dev/null 2>&1 || true

login_ok=0
for attempt in 1 2 3; do
  if aws ecr get-login-password --region ${config.ec2.region} | docker login --username AWS --password-stdin ${registry}; then
    login_ok=1
    break
  fi
  echo "ECR ログイン失敗(試行\${attempt}回目)、リトライします" >&2
  sleep 5
done
if [ "$login_ok" -ne 1 ]; then
  notify_bootstrap_failure "ECR login failed after 3 attempts"
  exit 1
fi

pull_ok=0
for attempt in 1 2 3; do
  if docker pull ${config.workerImage}; then
    pull_ok=1
    break
  fi
  echo "docker pull 失敗(試行\${attempt}回目)、リトライします" >&2
  sleep 5
done
if [ "$pull_ok" -ne 1 ]; then
  notify_bootstrap_failure "docker pull failed after 3 attempts"
  exit 1
fi

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

/** `launchRecordingInstance` が実際に確保できたインスタンスの情報。 */
export interface LaunchedInstance {
  instanceId: string;
  /** `CreateFleet` レスポンスに含まれなかった場合は null。 */
  instanceType: string | null;
  /** `CreateFleet` レスポンスに含まれなかった場合は null。 */
  availabilityZone: string | null;
  /**
   * 起動時点の Spot 単価（USD/時、`fetchSpotPrice()`）。取得できなければ null
   * （コスト推定側がフォールバック単価へ縮退する）。
   */
  spotPricePerHour: number | null;
}

/**
 * 確保できたインスタンスタイプ×AZの現在のSpot単価（USD/時）を取得する。
 * `CreateFleet` のレスポンスには単価が含まれないため、コスト推定（Issue #60、
 * `packages/shared/src/cost.ts`）のために別途1回だけ引く。
 *
 * `DescribeSpotPriceHistory` は「価格が変わった瞬間のイベント列」を新しい順に返す
 * ので、先頭1件が現在の単価。`StartTime` に現在時刻を渡して直近のイベントに絞る。
 *
 * **失敗しても録画ジョブは止めない**。単価はあくまで運用把握のための付随情報で、
 * これが取れないことを理由に起動を失敗させるとリトライ（最大10回）を無駄に消費し、
 * ユーザーの録画そのものを落としてしまうため、例外は握りつぶして null を返す。
 */
export async function fetchSpotPrice(
  instanceType: string | null,
  availabilityZone: string | null,
): Promise<number | null> {
  if (instanceType === null || availabilityZone === null) {
    return null;
  }
  try {
    const result = await ec2.send(
      new DescribeSpotPriceHistoryCommand({
        InstanceTypes: [instanceType as InstanceType],
        AvailabilityZone: availabilityZone,
        // ワーカーAMIはAmazon Linux系（ECS最適化AL2023）なので Linux/UNIX 帯。
        ProductDescriptions: ["Linux/UNIX"],
        StartTime: new Date(),
        MaxResults: 1,
      }),
    );
    const price = result.SpotPriceHistory?.[0]?.SpotPrice;
    if (price === undefined) {
      return null;
    }
    const parsed = Number(price);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "spot_price_lookup_failed",
        instanceType,
        availabilityZone,
        message: err instanceof Error ? err.message : String(err),
      }),
    );
    return null;
  }
}

/**
 * EC2 Fleet でワーカーインスタンスを1台起動して録画ジョブを実行する。
 * 起動したインスタンスの情報（インスタンスID・実際に確保されたインスタンスタイプ・
 * アベイラビリティゾーン）を返す。
 *
 * ベースの Launch Template（AMI/IAM/SGはCDK側で設定済み）に対し、ジョブ固有の
 * UserData のみを持つ新しいバージョンを作成し、そのバージョンを参照する
 * `CreateFleet`（`Type: "instant"`）で即時に1台起動する。サブネット（=AZ）×
 * 候補インスタンスタイプ（`getCandidateInstanceTypes()`、th11のみ`.2xlarge`帯の
 * 別リストを使う。touhou-recorder `reports/40`参照）の全組み合わせを Overrides に
 * 渡し `price-capacity-optimized` 戦略（`SingleInstanceType: false`）で配置する
 * ことで、単一AZ・単一インスタンスタイプでのSpot枯渇に対する耐性を持たせる
 * （PoC reports/17、Issue #29）。実際にどの候補が確保されたかは `CreateFleet` の
 * レスポンス（`result.Instances[0]`）からそのまま読み取れ、追加の `DescribeInstances`
 * 呼び出しは不要。ただし**Spot単価だけはレスポンスに含まれない**ため、コスト推定
 * （Issue #60）用に `fetchSpotPrice()` で1回だけ別途取得する。
 */
export async function launchRecordingInstance(
  config: ApiConfig,
  job: JobRecord,
  taskToken: string,
): Promise<LaunchedInstance> {
  const userData = buildUserData(config, job, taskToken);
  const candidateInstanceTypes = getCandidateInstanceTypes(job.game);

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
          Overrides: config.ec2.subnetIds.flatMap((subnetId) =>
            candidateInstanceTypes.map((instanceType) => ({
              SubnetId: subnetId,
              InstanceType: instanceType,
            })),
          ),
        },
      ],
      TargetCapacitySpecification: {
        TotalTargetCapacity: 1,
        DefaultTargetCapacityType: "spot",
      },
      SpotOptions: {
        AllocationStrategy: "price-capacity-optimized",
        SingleInstanceType: false,
        SingleAvailabilityZone: false,
        InstanceInterruptionBehavior: "terminate",
      },
      TagSpecifications: [
        {
          ResourceType: "instance",
          Tags: [
            { Key: "Name", Value: "sattori-recorder" },
            { Key: JOB_ID_TAG_KEY, Value: job.jobId },
          ],
        },
      ],
    }),
  );

  const launchedInstance = result.Instances?.[0];
  const instanceId = launchedInstance?.InstanceIds?.[0];
  if (!instanceId) {
    const reason = result.Errors?.map((e) => `${e.ErrorCode}: ${e.ErrorMessage}`).join("; ");
    throw new Error(
      `EC2 Fleet でのインスタンス起動に失敗しました（InstanceId 不明）${reason ? `: ${reason}` : ""}`,
    );
  }
  const instanceType = launchedInstance.InstanceType ?? null;
  const availabilityZone = launchedInstance.AvailabilityZone ?? null;
  return {
    instanceId,
    instanceType,
    availabilityZone,
    spotPricePerHour: await fetchSpotPrice(instanceType, availabilityZone),
  };
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

/**
 * ジョブに紐づく「まだ終了していない」EC2インスタンスをタグ(`sattori:jobId`)から探す
 * （Issue #59のレビュー指摘）。
 *
 * `JobRecord.instanceId` は Launch Lambda が `CreateFleet` の**後**に書き込むため、
 * 起動直後（`queued`/`launching`）のジョブを緊急停止すると、DynamoDBを読んだ時点では
 * まだ未記録で、直後に書き込まれたインスタンスを取り逃す（Step Functionsは実行中の
 * Lambda呼び出しをキャンセルしないため、`StopExecution`後も`CreateFleet`は完了しうる）。
 * タグはインスタンス作成時に`TagSpecifications`で付くのでDynamoDBへの書き込みを
 * 待たずに発見でき、Step Functionsのリトライで複数台が孤児化した場合もまとめて拾える。
 */
export async function findJobInstanceIds(jobId: string): Promise<string[]> {
  const result = await ec2.send(
    new DescribeInstancesCommand({
      Filters: [
        { Name: `tag:${JOB_ID_TAG_KEY}`, Values: [jobId] },
        // terminated/shutting-down は既に課金が止まっているので対象外。
        { Name: "instance-state-name", Values: ["pending", "running", "stopping", "stopped"] },
      ],
    }),
  );
  return (result.Reservations ?? []).flatMap((reservation) =>
    (reservation.Instances ?? [])
      .map((instance) => instance.InstanceId)
      .filter((instanceId): instanceId is string => instanceId !== undefined),
  );
}
