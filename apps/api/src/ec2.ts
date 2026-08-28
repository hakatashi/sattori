import {
  CreateFleetCommand,
  CreateLaunchTemplateVersionCommand,
  DescribeInstancesCommand,
  type DescribeInstancesCommandOutput,
  DescribeSpotPriceHistoryCommand,
  EC2Client,
  type _InstanceType as InstanceType,
  TerminateInstancesCommand,
} from "@aws-sdk/client-ec2";
import type { JobRecord } from "@sattori/shared";
import type { ApiConfig } from "./config.js";
import { buildWorkerEnv } from "./workerEnv.js";

const ec2 = new EC2Client({});

/** インスタンスに付与しているジョブ識別用のタグキー（`buildCreateFleetInput`と対で使う）。 */
export const JOB_ID_TAG_KEY = "sattori:jobId";

/**
 * 「まだ課金が続いている」とみなすインスタンスの状態。`terminated`/`shutting-down` は
 * 既に課金が止まっているので、terminate対象を探す検索からは常に除外する。
 */
const LIVE_INSTANCE_STATES = ["pending", "running", "stopping", "stopped"];

/**
 * Spot Fleet に含める候補インスタンスタイプ（th11・th20以外の既定。th10もこちらに含まれる、
 * touhou-recorder reports/60でc7i.xlarge実測$0.033/hourの品質確認済み）。`c7i.xlarge` 単独だと、
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

/**
 * th20専用の候補インスタンスタイプ（Issue #87）。th20は内部描画解像度が960p相当
 * （1280x960）へ上がっており、Xvfb+wined3d+llvmpipeのソフトウェアレンダリングでは
 * th11をさらに上回る描画負荷になる。touhou-recorder `reports/46` のeu-south-2実機
 * 比較で、th11の基準である`.2xlarge`帯（8vCPU）では**高負荷区間（スペルカード
 * 「巌となるさざれ石」）のゲーム内実測fpsが11.7〜32.5fpsまで持続的に落ち込む**一方、
 * `.4xlarge`帯（16vCPU/32GiB）では13.2fpsへの単発の落ち込み1回を除き57.6〜60.0fpsを
 * 維持した。総録画時間（＝ゲーム進行速度の低下を映す指標）もローカル基準に対して
 * `.2xlarge`が+8.9%に対し`.4xlarge`は-1.8%と、実機の全指標で明確な差が出ている。
 *
 * **`c7i.4xlarge` 1タイプしか挙げていないのは意図的**。reports/46 でth20の実機検証を
 * 通ったのはこのタイプだけで、他タイプ（`c7a`/`m7i`の`.4xlarge`）は「同じvCPU数・
 * 同じリージョンで検証済みの系統だから」という推測でしか根拠づけられない。この種の
 * 推測は繰り返し裏切られている（AGENTS.md §3）ため、Spotプール数の後退（＝
 * `InsufficientInstanceCapacity` 起因の起動失敗）を承知のうえで検証済みの1本に絞る。
 * プールを広げたい場合はth20での実機検証を先に行うこと（Issue #98）。
 *
 * なお**th20は原則として自宅ワーカーで低速録画する**方針（Issue #68、
 * `workerRouting.ts`）なので、このEC2経路は自宅ワーカーが空いていないときの
 * フォールバック（等倍録画）である。
 */
const TH20_CANDIDATE_INSTANCE_TYPES: InstanceType[] = [
  "c7i.4xlarge", // Intel Sapphire Rapids 16vCPU/32GiB。reports/46実測で重複フレーム率1.4%
];

function getCandidateInstanceTypes(game: JobRecord["game"]): InstanceType[] {
  switch (game) {
    case "th11":
      return TH11_CANDIDATE_INSTANCE_TYPES;
    case "th20":
      return TH20_CANDIDATE_INSTANCE_TYPES;
    default:
      return DEFAULT_CANDIDATE_INSTANCE_TYPES;
  }
}

/**
 * 値をシェルの単一引用符で安全に囲む。値の中に `'` があっても
 * `'\''`（一旦引用符を閉じ、エスケープしたシングルクォート文字を足し、
 * また開く）で表現するため、シェルメタ文字（`$(`・`;`・改行等）が混ざっていても
 * 単なる文字列として展開される。
 *
 * `buildUserData()` が UserData スクリプトへ埋め込む値はジョブ固有（`replayKey`
 * 等）で、入口（`handlers/requestMagicLink.ts`）で形式検証しているとはいえ、
 * **入口検証だけに頼らない**多層防御としてすべての値をこの関数に通す（Issue #127
 * SEC-1）。DB内の既存汚染データや検証をすり抜けた値が来ても、ここでコマンド
 * インジェクションに変換されないようにする最後の防波堤。
 */
function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
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

  // 環境変数の中身は自宅ワーカー（Issue #49）と共有する（`workerEnv.ts`）。
  // taskToken だけはスクリプト冒頭で $TASK_TOKEN に格納済み（bootstrap 失敗時の
  // SendTaskFailure 通知と共有するため）なので、二重埋め込みを避けそれを参照する。
  //
  // **EC2 では低速録画（Issue #68）を行わない**（録画に倍の実時間がかかり、その分
  // Spot料金も倍になるため。低速録画は電気代しかかからない自宅ワーカー限定）。
  // ユーザーが低速録画を選んでいても、この経路まで落ちてきた時点で等倍録画になる。
  const envFlags = Object.entries(
    buildWorkerEnv(config, job, taskToken, { slowMotion: false }),
  ).map(([key, value]) =>
    key === "TASK_TOKEN" ? `-e TASK_TOKEN="$TASK_TOKEN"` : `-e ${key}=${shellEscape(value)}`,
  );

  // trap EXIT で必ず shutdown する（Spot 終了 = 課金停止）。ECR ログインや
  // docker 実行が失敗しても、インスタンスを起動したまま残さない（孤児防止）。
  // set -e は付けない（途中失敗でも trap を通って確実に停止させるため）。
  const script = `#!/bin/bash
export AWS_DEFAULT_REGION=${config.ec2.region}
trap 'shutdown -h now' EXIT
TASK_TOKEN=${shellEscape(taskToken)}

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
        { Name: "instance-state-name", Values: LIVE_INSTANCE_STATES },
      ],
    }),
  );
  return (result.Reservations ?? []).flatMap((reservation) =>
    (reservation.Instances ?? [])
      .map((instance) => instance.InstanceId)
      .filter((instanceId): instanceId is string => instanceId !== undefined),
  );
}

/** タグ(`sattori:jobId`)から見つけた、まだ生きている録画インスタンス1台ぶんの情報。 */
export interface TaggedInstance {
  instanceId: string;
  /** タグに書かれたジョブID。 */
  jobId: string;
  /**
   * EC2が記録した起動時刻。`DescribeInstances` が返さなかった場合のみ null で、
   * 判定側は「たった今起動した」ものとして扱う（＝猶予に守られ、terminateされない。
   * `orphanInstances.ts` 参照）。
   */
  launchTime: Date | null;
}

/**
 * ジョブIDタグを持つ「まだ生きている」インスタンスを**全ジョブ横断で**列挙する
 * （Issue #23、孤児インスタンスの定期掃除）。
 *
 * `findJobInstanceIds()` がジョブ1件ぶんを引くのに対し、こちらは掃除役が
 * 「AWS側に実在するインスタンス」を起点に走査するために使う。DynamoDBのジョブ
 * レコードを起点にすると、**`instanceId` を書き込む前に `Launch` が死んだケース
 * （＝Issue #23がまさに問題にしている孤児）を構造的に発見できない**ため、
 * 向きを逆にすることが要点。
 */
export async function listTaggedInstances(): Promise<TaggedInstance[]> {
  const instances: TaggedInstance[] = [];
  let nextToken: string | undefined;
  do {
    const result: DescribeInstancesCommandOutput = await ec2.send(
      new DescribeInstancesCommand({
        Filters: [
          // 値は問わずタグの有無だけで絞る（jobIdは事前に分からないため）。
          { Name: "tag-key", Values: [JOB_ID_TAG_KEY] },
          { Name: "instance-state-name", Values: LIVE_INSTANCE_STATES },
        ],
        NextToken: nextToken,
      }),
    );
    for (const reservation of result.Reservations ?? []) {
      for (const instance of reservation.Instances ?? []) {
        const instanceId = instance.InstanceId;
        const jobId = instance.Tags?.find((tag) => tag.Key === JOB_ID_TAG_KEY)?.Value;
        if (instanceId === undefined || jobId === undefined || jobId === "") {
          continue;
        }
        instances.push({
          instanceId,
          jobId,
          launchTime: instance.LaunchTime ?? null,
        });
      }
    }
    nextToken = result.NextToken;
  } while (nextToken);
  return instances;
}
