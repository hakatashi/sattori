import {
  CreateFleetCommand,
  type CreateFleetCommandOutput,
  type CreateFleetError,
  CreateLaunchTemplateVersionCommand,
  DeleteLaunchTemplateVersionsCommand,
  DescribeInstancesCommand,
  type DescribeInstancesCommandOutput,
  DescribeSpotPriceHistoryCommand,
  DescribeSubnetsCommand,
  EC2Client,
  type _InstanceType as InstanceType,
  TerminateInstancesCommand,
} from "@aws-sdk/client-ec2";
import type { Ec2RecordingStep, JobRecord } from "@sattori/shared";
import { vcpusForInstanceType } from "@sattori/shared";
import type { ApiConfig, GpuFallbackConfig } from "./config.js";
import { workerRegions } from "./config.js";
import { buildWorkerEnv } from "./workerEnv.js";

/**
 * リージョン別のEC2クライアント（Issue #296）。GPUジョブは容量不足時に
 * フォールバック先リージョン（`eu-north-1`）で起動するため、EC2のAPIは常に
 * 「どのリージョンに対して呼ぶか」を明示する。`region`省略時はLambda自身の
 * リージョン（一次リージョン）。
 */
const ec2Clients = new Map<string, EC2Client>();

function ec2ClientFor(region?: string): EC2Client {
  const key = region ?? "";
  let client = ec2Clients.get(key);
  if (!client) {
    client = new EC2Client(region ? { region } : {});
    ec2Clients.set(key, client);
  }
  return client;
}

/**
 * Spot在庫そのものの枯渇を表す`CreateFleet`のエラーコード（Issue #296）。段の容量不足の判定と、
 * 次の段へ進むかの判定に使う。`VcpuLimitExceeded`/`MaxSpotInstanceCountExceeded`
 * （クォータ超過）は一次リージョンの台帳（`gpuSlots.ts`）とAWS側の実使用量のずれが原因で、
 * 他のリージョンへ逃がしても解消しないため含めない。
 */
export const SPOT_CAPACITY_ERROR_CODES = [
  "InsufficientInstanceCapacity",
  "UnfulfillableCapacity",
];

/**
 * `CreateFleet`が1台も確保できなかったことを表す例外。判定のためにエラーコードを構造化して
 * 持つ。メッセージには`ErrorCode: ErrorMessage`をそのまま含める——`handleFailure.ts`の
 * `CAPACITY_ERROR_CODES`は例外メッセージの部分一致で容量不足を判定している（Issue #282）ため、
 * この形式を崩さないこと。
 *
 * `capacityExhausted`は、その段の全サブネット・全候補がSpot在庫の枯渇で失敗したこと
 * （`isTierCapacityExhausted()`）を表す。true の段はジョブが終わるまで二度と試さない
 * （Issue #315、`docs/decisions/0063`）。
 */
export class FleetLaunchError extends Error {
  constructor(
    message: string,
    readonly errorCodes: string[],
    readonly capacityExhausted: boolean = false,
  ) {
    super(message);
    this.name = "FleetLaunchError";
  }
}

/** インスタンスに付与しているジョブ識別用のタグキー（`buildCreateFleetInput`と対で使う）。 */
export const JOB_ID_TAG_KEY = "sattori:jobId";

/**
 * 「まだ課金が続いている」とみなすインスタンスの状態。`terminated`/`shutting-down` は
 * 既に課金が止まっているので、terminate対象を探す検索からは常に除外する。
 */
const LIVE_INSTANCE_STATES = ["pending", "running", "stopping", "stopped"];

/**
 * `launchRecordingInstance()` の候補タイプ絞り込みに使う制約。GPU vCPU容量リース
 * （Issue #270、`docs/decisions/0056-gpu-vcpu-lease-and-queue.md`）専用の値で、
 * CPUの段の候補には一切影響しない。
 */
export interface LaunchConstraints {
  /**
   * 確保済みリースのvCPU上限。GPUの段でのみ意味を持ち、これを超えるvCPU数の
   * インスタンスタイプ（`GPU_INSTANCE_TYPE_VCPUS`）を候補から除外する。
   * `undefined` なら制約なし（段の全候補）。
   */
  maxVcpu?: number;
}

/**
 * 段の候補インスタンスタイプ（`recordingPlan.ts`）を、GPUリースのvCPU上限で絞り込む。
 * module-privateではなくexportする（`ec2.test.ts`から直接検証するため）。
 */
export function getCandidateInstanceTypes(
  step: Ec2RecordingStep,
  constraints: LaunchConstraints = {},
): InstanceType[] {
  const base = step.instanceTypes as InstanceType[];
  if (constraints.maxVcpu === undefined || step.platform !== "gpu") {
    return [...base];
  }
  const filtered = base.filter(
    (instanceType) => (vcpusForInstanceType(instanceType) ?? Infinity) <= constraints.maxVcpu!,
  );
  if (filtered.length === 0) {
    // 理屈上到達不能(GPU候補の最小vCPU数はacquireGpuSlotの最小確保量と一致させて
    // あるため、リースが実在すれば必ず1つは残る)。黙って全候補へフォールバックせず、
    // 設計の前提が崩れたことをそのまま失敗させる。
    throw new Error(
      `GPUリースのvCPU上限(${constraints.maxVcpu})に収まる候補インスタンスタイプが無い`,
    );
  }
  return filtered;
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
export function buildUserData(
  config: ApiConfig,
  job: JobRecord,
  taskToken: string,
  options: { workerImage?: string; region?: string; gpu?: boolean } = {},
): string {
  // GPUの段（`recordingPlan.ts`）は別ECRイメージ（`worker-gpu`）・GPU用カスタムAMI
  // （Launch Templateはこの関数の外、`launchTierFor()`側で分岐する）を使う。AMIにNVIDIA
  // GRIDドライバ・nvidia-container-toolkitを事前導入済みのため、`docker run`にGPUを渡す
  // `--gpus all`を追加するだけでよい（`docs/decisions/0046-gpu-ec2-instance-and-fixed-ami.md`）。
  const isGpuJob = options.gpu ?? false;
  // フォールバック先リージョン（Issue #296）で起動する場合は、そのリージョンのECR
  // レプリカのイメージを呼び出し側が渡す。ECRのログイン先はイメージのレジストリから
  // 導く——**`AWS_DEFAULT_REGION`・awslogs・Step Functions通知は一次リージョンの
  // ままにする**（データ面はすべて一次リージョンにあり、taskTokenもリージョン固有）。
  const workerImage = options.workerImage ?? (isGpuJob ? config.workerGpuImage : config.workerImage);
  const registry = workerImage.split("/")[0] ?? "";
  const ecrRegion = ecrRegionOf(registry) ?? config.ec2.region;

  // 環境変数の中身は自宅ワーカー（Issue #49）と共有する（`workerEnv.ts`）。
  // taskToken だけはスクリプト冒頭で $TASK_TOKEN に格納済み（bootstrap 失敗時の
  // SendTaskFailure 通知と共有するため）なので、二重埋め込みを避けそれを参照する。
  //
  // Spot中断監視（Issue #96）はIMDSが存在するEC2でのみ有効にする。
  // 録画速度は`buildWorkerEnv()`が`job.options`から読む（`Launch`が段の速度を書いてから呼ぶ）。
  const envFlags = Object.entries(
    buildWorkerEnv(config, job, taskToken, {
      spotInterruptionWatch: true,
      // 出力・タイトル資産はワーカーと同じリージョンのバケットを使う（Issue #313）。
      dataRegion: options.region ?? config.ec2.region,
      gpuWorker: isGpuJob,
    }),
  ).map(([key, value]) =>
    key === "TASK_TOKEN" ? `-e TASK_TOKEN="$TASK_TOKEN"` : `-e ${key}=${shellEscape(value)}`,
  );

  // ECS 最適化 AMI（CPU系ワーカー専用）は docker を含むが、プレーンな docker ホストと
  // して使う。常駐する ECS エージェントが 4vCPU を消費し、高負荷区間(弾幕)で ffmpeg の
  // x11grab キャプチャと CPU コンテンションを起こしてフレーム取りこぼし(処理落ち)を
  // 増やすため停止する（検証: 八雲藍(Extra ボス)戦の重複フレーム率が
  // 15-26%(有効時) → 4.8%(停止時) に改善）。GPU用カスタムAMIはECS基盤ではなく
  // このエージェント自体が存在しないため、この処理自体を行わない。
  const ecsDisableStep = isGpuJob
    ? ""
    : `
# ECS 最適化 AMI は docker を含むが、プレーンな docker ホストとして使う。常駐する
# ECS エージェントが 4vCPU を消費し、高負荷区間(弾幕)で ffmpeg の x11grab キャプチャと
# CPU コンテンションを起こしてフレーム取りこぼし(処理落ち)を増やすため停止する。
# 検証: 八雲藍(Extra ボス)戦の重複フレーム率が 15-26%(有効時) → 4.8%(停止時) に改善。
systemctl disable --now ecs >/dev/null 2>&1 || true`;

  // GPU用カスタムAMIはnvidia-container-toolkit導入済み前提で、コンテナへGPUを
  // 渡すために`--gpus all`が必要（CPU系では付けない）。
  // またホスト側のXorg NVIDIAドライバ(nvidia_drv.so・libglxserver_nvidia.so)・
  // 32bitクライアントライブラリ(libGLX_nvidia.so等)・Vulkan ICD設定をコンテナへ
  // マウントし、X11共有メモリ・PulseAudioのために--ipc=hostを付与する。
  //
  // 【重要】ディレクトリ丸ごとマウントしてはいけない（旧実装のバグ、Issue #82実機
  // 検証で判明）。bind mountはマウント先の既存内容を隠すため、コンテナ自身が
  // 提供するファイル（`xserver-xorg-core`の`libwfb.so`・32bit版Mesa等）がホスト側の
  // 内容（NVIDIA関連ファイルのみ）で丸ごと隠れてしまう
  // （`docs/decisions/0052-gpu-xorg-driver-file-level-mount-not-directory.md`）。
  // 個々のファイルだけを実行時にシェル側で列挙してマウントすることで、コンテナの
  // 標準ファイルを維持したままNVIDIA用ファイルだけを追加する。
  //
  // 【重要】nvidia-container-toolkit(`--gpus all`)は64bit版のNVIDIAユーザー
  // スペースライブラリ(`libnvidia-*.so`等、`/usr/lib/x86_64-linux-gnu/`)は自動で
  // コンテナへマウントするが、**32bit互換ライブラリの自動マウントには対応していない**
  // （既知の制約）。th15のような32bitタイトルではwineの32bitプロセスが
  // `/usr/lib/i386-linux-gnu/libGLX_nvidia.so.0`等を見つけられず、エラーにはならずに
  // Mesaのソフトウェアレンダラ(llvmpipe)へ静かにフォールバックする
  // （GPU描画が効いているように見えて実際は効いていない状態になる。
  // `docs/decisions/0053-mount-32bit-nvidia-client-libraries-for-wine.md`）。
  // ホストAMI側に32bit互換ドライバ(`--compat32-libdir`)を導入したうえで、
  // 該当ファイルを個別マウントすることで解消する（th06nc等64bit専用タイトルは
  // 32bitプロセスを持たないため実害が無く、このマウントも空になるだけで無害）。
  const gpuXorgMountSetup = isGpuJob
    ? `
# NVIDIA関連ファイルだけを個別にコンテナへマウントする準備（理由は docker run
# 呼び出し部のコメント参照）。バージョン番号を含むファイル名は決め打ちにせず
# グロブで拾う。ファイルが存在しない（64bit専用タイトル・32bit互換ドライバ未導入の
# ホスト等）場合は単に無視する。
GPU_NVIDIA_MOUNTS=""
for f in \\
  /usr/lib/xorg/modules/drivers/nvidia_drv.so \\
  /usr/lib/xorg/modules/extensions/libglxserver_nvidia.so* \\
  /usr/lib/i386-linux-gnu/libnvidia-*.so* \\
  /usr/lib/i386-linux-gnu/libGLX_nvidia.so* \\
  /usr/lib/i386-linux-gnu/libEGL_nvidia.so* \\
  /usr/lib/i386-linux-gnu/libGLESv1_CM_nvidia.so* \\
  /usr/lib/i386-linux-gnu/libGLESv2_nvidia.so*; do
  if [ -e "$f" ]; then
    GPU_NVIDIA_MOUNTS="$GPU_NVIDIA_MOUNTS -v $f:$f:ro"
  fi
done
# /dev/nvidia* を --device で明示的に渡す。--gpus all だけだとホストの systemctl
# daemon-reload（起動後数分で走る）でコンテナのcgroupデバイス許可が失われ、録画途中から
# NVML/CUDAが "Unknown Error"/CUDA_ERROR_NO_DEVICE になり配信用NVENC変換が失敗する
# （NVIDIA/nvidia-container-toolkit 既知の問題、Issue #288 th15本番ジョブで再現）。
for d in /dev/nvidia*; do
  if [ -e "$d" ]; then
    GPU_NVIDIA_MOUNTS="$GPU_NVIDIA_MOUNTS --device $d"
  fi
done`
    : "";
  const dockerRunFlags = isGpuJob
    ? "--rm --gpus all --ipc=host -e NVIDIA_DRIVER_CAPABILITIES=all -e NVIDIA_VISIBLE_DEVICES=all -e VK_LOADER_DEBUG=all $GPU_NVIDIA_MOUNTS -v /tmp/.X11-unix:/tmp/.X11-unix -v /etc/vulkan/icd.d:/etc/vulkan/icd.d:ro"
    : "--rm";

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
${ecsDisableStep}
${gpuXorgMountSetup}
# プレーンな docker ホストとして使うため docker のみ明示起動。
systemctl enable --now docker >/dev/null 2>&1 || service docker start >/dev/null 2>&1 || true
# aws CLI が無い環境向けのフォールバック導入。
command -v aws >/dev/null 2>&1 || dnf install -y awscli >/dev/null 2>&1 || dnf install -y aws-cli >/dev/null 2>&1 || true

login_ok=0
for attempt in 1 2 3; do
  if aws ecr get-login-password --region ${ecrRegion} | docker login --username AWS --password-stdin ${registry}; then
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
  if docker pull ${workerImage}; then
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

docker run ${dockerRunFlags} \\
  --log-driver awslogs \\
  --log-opt awslogs-region=${config.ec2.region} \\
  --log-opt awslogs-group=${config.logGroup} \\
  --log-opt awslogs-stream=${job.jobId} \\
  ${envFlags.join(" \\\n  ")} \\
  ${workerImage}
`;
  return Buffer.from(script, "utf-8").toString("base64");
}

/**
 * ECRのレジストリホスト名（`<account>.dkr.ecr.<region>.amazonaws.com`）からリージョンを
 * 取り出す。形式が違えば null（呼び出し側が一次リージョンへ縮退する）。
 */
export function ecrRegionOf(registry: string): string | null {
  const match = /^\d+\.dkr\.ecr\.([a-z0-9-]+)\.amazonaws\.com$/.exec(registry);
  return match?.[1] ?? null;
}

/** `launchRecordingInstance` が実際に確保できたインスタンスの情報。 */
export interface LaunchedInstance {
  instanceId: string;
  /** インスタンスを起動したリージョン（Issue #296）。 */
  region: string;
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
  region?: string,
): Promise<number | null> {
  if (instanceType === null || availabilityZone === null) {
    return null;
  }
  try {
    const result = await ec2ClientFor(region).send(
      new DescribeSpotPriceHistoryCommand({
        InstanceTypes: [instanceType as InstanceType],
        AvailabilityZone: availabilityZone,
        // CPU系ワーカーAMIはAmazon Linux系（ECS最適化AL2023）、GPU系ワーカーAMI
        // （Issue #241）もUbuntu系のためいずれも Linux/UNIX 帯。
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


/** 段を起動するための解決済みの情報。 */
export interface LaunchTier {
  /** 段の`id`（`JobRecord.capacityExhaustedTargets`に記録する識別子）。 */
  id: string;
  region: string;
  gpu: boolean;
  launchTemplate: { LaunchTemplateId: string } | { LaunchTemplateName: string };
  /** 前の段で確保できれば要らない問い合わせなので、試す直前に解決する。 */
  resolveSubnetIds: () => Promise<string[]>;
  /** 省略時は`buildUserData()`の既定（一次リージョンのECR）。 */
  workerImage: string | undefined;
  candidateInstanceTypes: InstanceType[];
}

/**
 * 段をLaunch Template・サブネット・ワーカーイメージへ解決する。一次リージョンならCPU/GPUの
 * Launch Template、GPUのフォールバック先リージョンならそちらのGPU Launch Template（Issue #296）。
 * それ以外（フォールバック先が未設定の環境を含む）は起動できないので null。
 */
export function launchTierFor(
  config: ApiConfig,
  step: Ec2RecordingStep,
  constraints: LaunchConstraints = {},
): LaunchTier | null {
  const gpu = step.platform === "gpu";
  const candidateInstanceTypes = getCandidateInstanceTypes(step, constraints);
  if (step.region === config.ec2.region) {
    return {
      id: step.id,
      region: step.region,
      gpu,
      launchTemplate: {
        LaunchTemplateId: gpu ? config.ec2.gpuLaunchTemplateId : config.ec2.launchTemplateId,
      },
      resolveSubnetIds: async () => config.ec2.subnetIds,
      workerImage: undefined,
      candidateInstanceTypes,
    };
  }
  const fallback = config.ec2.gpuFallback;
  if (gpu && fallback !== null && step.region === fallback.region) {
    return {
      id: step.id,
      region: step.region,
      gpu,
      launchTemplate: { LaunchTemplateName: fallback.launchTemplateName },
      resolveSubnetIds: () => resolveFallbackSubnetIds(fallback),
      workerImage: fallback.workerGpuImage,
      candidateInstanceTypes,
    };
  }
  return null;
}

/**
 * フォールバック先のサブネットID（Lambdaのコンテナ内でキャッシュする）。
 * 本体スタックとフォールバックスタックの間でクロスリージョン参照を張らない
 * （`infra/README.md`）ため、CDKの出力ではなくタグで実行時に引く。
 */
const fallbackSubnetCache = new Map<string, string[]>();

async function resolveFallbackSubnetIds(fallback: GpuFallbackConfig): Promise<string[]> {
  const cached = fallbackSubnetCache.get(fallback.region);
  if (cached) {
    return cached;
  }
  const result = await ec2ClientFor(fallback.region).send(
    new DescribeSubnetsCommand({
      Filters: [{ Name: `tag:${fallback.subnetTagKey}`, Values: ["true"] }],
    }),
  );
  const subnetIds = (result.Subnets ?? [])
    .map((subnet) => subnet.SubnetId)
    .filter((subnetId): subnetId is string => subnetId !== undefined)
    .sort();
  if (subnetIds.length === 0) {
    throw new Error(
      `フォールバック先(${fallback.region})にタグ ${fallback.subnetTagKey} の付いたサブネットがありません`,
    );
  }
  fallbackSubnetCache.set(fallback.region, subnetIds);
  return subnetIds;
}

/**
 * その段の全サブネット・全候補がSpot在庫の枯渇で失敗したか（Issue #315）。1AZの失敗で段全体を
 * 外さないよう、クォータ超過などが1件でも混ざっていれば false にする。
 *
 * `CreateFleet`は失敗した組み合わせごとに`Errors`を返す（2026-11-04に2タイプ×3サブネットで
 * 実機確認）。報告の無い組み合わせがあれば、試し切っていないとみなす。
 */
export function isTierCapacityExhausted(
  errors: CreateFleetError[],
  subnetIds: string[],
  candidateInstanceTypes: InstanceType[],
): boolean {
  if (
    errors.length === 0 ||
    !errors.every((e) => SPOT_CAPACITY_ERROR_CODES.includes(e.ErrorCode ?? ""))
  ) {
    return false;
  }
  const reported = new Set(
    errors.flatMap(({ LaunchTemplateAndOverrides: { Overrides: o } = {} }) =>
      o?.SubnetId && o.InstanceType ? [`${o.SubnetId}/${o.InstanceType}`] : [],
    ),
  );
  return subnetIds.every((subnetId) =>
    candidateInstanceTypes.every((type) => reported.has(`${subnetId}/${type}`)),
  );
}

/**
 * EC2 Fleet で録画の段（`recordingPlan.ts`）のワーカーインスタンスを1台起動する。
 * 起動したインスタンスの情報（インスタンスID・実際に確保されたインスタンスタイプ・
 * アベイラビリティゾーン）を返す。
 *
 * ベースの Launch Template（AMI/IAM/SGはCDK側で設定済み）に対し、ジョブ固有の
 * UserData のみを持つ新しいバージョンを作成し、そのバージョンを参照する
 * `CreateFleet`（`Type: "instant"`）で即時に1台起動する。サブネット（=AZ）×
 * 段の候補インスタンスタイプの全組み合わせを Overrides に渡し `price-capacity-optimized`
 * 戦略（`SingleInstanceType: false`）で配置することで、単一AZ・単一インスタンスタイプでの
 * Spot枯渇に対する耐性を持たせる（PoC reports/17、Issue #29）。実際にどの候補が確保されたかは
 * `CreateFleet` のレスポンス（`result.Instances[0]`）からそのまま読み取れる。ただし
 * **Spot単価だけはレスポンスに含まれない**ため、コスト推定（Issue #60）用に
 * `fetchSpotPrice()` で1回だけ別途取得する。
 *
 * 1台も確保できなければ`FleetLaunchError`を投げる。段の全サブネット・全候補がSpot在庫の枯渇で
 * 失敗したら`capacityExhausted`が立ち、呼び出し側（`handlers/sfn/launch.ts`）がその段を
 * 使い切ったものとして次の段へ進む（Issue #315、`docs/decisions/0063`）。価格では振り分けない
 * （`docs/decisions/0061`）。
 *
 * 作ったLaunch Templateバージョンは結果によらず
 * 消す。UserDataの中身は`CreateFleet`の時点でインスタンスへ渡っており、1テンプレートあたり
 * 10,000バージョンの上限に試行回数ぶん近づいていくのを避けるため（Issue #315）。
 */
export async function launchRecordingInstance(
  config: ApiConfig,
  job: JobRecord,
  taskToken: string,
  target: LaunchTier,
): Promise<LaunchedInstance> {
  const { candidateInstanceTypes } = target;
  const subnetIds = await target.resolveSubnetIds();
  const ec2 = ec2ClientFor(target.region);
  const userData = buildUserData(config, job, taskToken, {
    workerImage: target.workerImage,
    region: target.region,
    gpu: target.gpu,
  });
  const isGpuJob = target.gpu;

  const version = await ec2.send(
    new CreateLaunchTemplateVersionCommand({
      ...target.launchTemplate,
      // "$Default"ではなく"$Latest"を使う。CDKの`CfnLaunchTemplate`はAMI・SG等の
      // プロパティ変更のたびに新しいバージョンを作るが、そのバージョンを
      // `DefaultVersionNumber`へ自動的には昇格しない(`ModifyLaunchTemplate`の
      // 明示呼び出しが要る、CDK側にその仕組みは無い)。"$Default"のままだと、
      // スタック作成時点の最初のバージョンが永久にデフォルトのまま固定され、
      // 以降のCDKデプロイでAMIを変えてもジョブ起動には一切反映されない
      // (Issue #82実機検証で発覚。GPU用AMIを更新したがジョブが古いAMIのまま
      // 起動し続けていた)。"$Latest"なら直前のCDKデプロイが作った最新バージョンを
      // 毎回確実に継承する(`docs/decisions/0051-launch-template-source-version-latest-not-default.md`)。
      SourceVersion: "$Latest",
      LaunchTemplateData: { UserData: userData },
    }),
  );
  const versionNumber = version.LaunchTemplateVersion?.VersionNumber;
  if (versionNumber === undefined) {
    throw new Error("Launch Template バージョンの作成に失敗しました（VersionNumber 不明）");
  }

  let result: CreateFleetCommandOutput;
  try {
    result = await ec2.send(
      new CreateFleetCommand({
        Type: "instant",
        LaunchTemplateConfigs: [
          {
            LaunchTemplateSpecification: {
              ...target.launchTemplate,
              Version: String(versionNumber),
            },
            Overrides: subnetIds.flatMap((subnetId) =>
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
  } finally {
    await deleteLaunchTemplateVersion(job, target, versionNumber);
  }

  const launchedInstance = result.Instances?.[0];
  const instanceId = launchedInstance?.InstanceIds?.[0];
  if (!instanceId) {
    const errorCodes = result.Errors?.map((e) => e.ErrorCode).filter((code) => code !== undefined) ?? [];
    const reason = result.Errors?.map((e) => `${e.ErrorCode}: ${e.ErrorMessage}`).join("; ");
    // 失敗理由をCloudWatch Logsへ構造化して残す（Issue #270）。`errorCodes`は
    // `InsufficientInstanceCapacity`（Spot在庫の一時的な枯渇）と
    // `VcpuLimitExceeded`/`MaxSpotInstanceCountExceeded`（G系スポットのvCPUクオータ
    // 超過）を区別するためのもの。例外メッセージ自体にも含めているが、
    // CloudWatch Logs Insightsで集計・アラート判定するには構造化されたフィールドが要る。
    console.error(
      JSON.stringify({
        event: "create_fleet_failed",
        jobId: job.jobId,
        game: job.game,
        region: target.region,
        isGpuJob,
        candidateInstanceTypes,
        errorCodes,
      }),
    );
    throw new FleetLaunchError(
      `EC2 Fleet でのインスタンス起動に失敗しました（InstanceId 不明）${reason ? `: ${reason}` : ""}`,
      errorCodes,
      isTierCapacityExhausted(result.Errors ?? [], subnetIds, candidateInstanceTypes),
    );
  }
  const instanceType = launchedInstance.InstanceType ?? null;
  const availabilityZone = launchedInstance.AvailabilityZone ?? null;
  return {
    instanceId,
    region: target.region,
    instanceType,
    availabilityZone,
    spotPricePerHour: await fetchSpotPrice(instanceType, availabilityZone, target.region),
  };
}

/**
 * `launchInTier()`が作ったLaunch Templateバージョンを消す。最新のバージョンを消しても
 * `$Latest`は残っているうち最新のものを指し、番号は再利用されない（2026-11-04に実機確認）。
 * 消せなくても起動の成否には関係ないので、ログだけ残して続行する。
 */
async function deleteLaunchTemplateVersion(
  job: JobRecord,
  target: LaunchTier,
  versionNumber: number,
): Promise<void> {
  try {
    const result = await ec2ClientFor(target.region).send(
      new DeleteLaunchTemplateVersionsCommand({
        ...target.launchTemplate,
        Versions: [String(versionNumber)],
      }),
    );
    if (result?.UnsuccessfullyDeletedLaunchTemplateVersions?.length) {
      throw new Error(
        result.UnsuccessfullyDeletedLaunchTemplateVersions.map(
          (failure) => failure.ResponseError?.Code,
        ).join(", "),
      );
    }
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "launch_template_version_delete_failed",
        jobId: job.jobId,
        region: target.region,
        versionNumber,
        message: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

/**
 * ジョブ失敗（Spot中断・タイムアウト等）時に、孤児化した可能性のあるインスタンスを
 * terminate する。既に終了済み・存在しない場合も冪等に成功扱いとする
 * （リトライの度に毎回呼ばれるため）。
 *
 * `region`はインスタンスのあるリージョン（Issue #296）。省略時は一次リージョン。
 * 別リージョンのインスタンスIDを渡すと`InvalidInstanceID.NotFound`で空振りする
 * （＝終了できないまま成功扱いになる）ため、`JobRecord.workerRegion`や
 * `findJobInstances()`の結果のリージョンを必ず渡すこと。
 */
export async function terminateInstance(instanceId: string, region?: string): Promise<void> {
  try {
    await ec2ClientFor(region).send(new TerminateInstancesCommand({ InstanceIds: [instanceId] }));
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
 *
 * GPUジョブはフォールバック先リージョンでも起動しうる（Issue #296）ため、
 * **ワーカーを起動しうる全リージョン**（`workerRegions()`）を探す。
 */
export async function findJobInstances(jobId: string): Promise<RegionalInstance[]> {
  const perRegion = await Promise.all(
    workerRegions().map(async (region) => {
      const result = await ec2ClientFor(region).send(
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
          .filter((instanceId): instanceId is string => instanceId !== undefined)
          .map((instanceId) => ({ instanceId, region })),
      );
    }),
  );
  return perRegion.flat();
}

/** リージョン付きのインスタンスID（Issue #296）。 */
export interface RegionalInstance {
  instanceId: string;
  region: string;
}

/** タグ(`sattori:jobId`)から見つけた、まだ生きている録画インスタンス1台ぶんの情報。 */
export interface TaggedInstance {
  instanceId: string;
  /** インスタンスのあるリージョン（Issue #296）。 */
  region: string;
  /** タグに書かれたジョブID。 */
  jobId: string;
  /**
   * EC2が記録した起動時刻。`DescribeInstances` が返さなかった場合のみ null で、
   * 判定側は「たった今起動した」ものとして扱う（＝猶予に守られ、terminateされない。
   * `orphanInstances.ts` 参照）。
   */
  launchTime: Date | null;
  /**
   * インスタンスタイプ。GPUリースのリコンサイラ（Issue #270、
   * `handlers/sweepOrphanInstances.ts`）が実在インスタンスのvCPU合計を計算するために
   * 使う。`DescribeInstances` が返さなかった場合のみ null。
   */
  instanceType: string | null;
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
  // GPUのフォールバック先リージョン（Issue #296）も走査する。1リージョンの列挙失敗は
  // 例外のまま上げる（掃除役が「何も見えていないのに正常終了」しないように）。
  const perRegion = await Promise.all(workerRegions().map(listTaggedInstancesIn));
  return perRegion.flat();
}

async function listTaggedInstancesIn(region: string): Promise<TaggedInstance[]> {
  const instances: TaggedInstance[] = [];
  let nextToken: string | undefined;
  do {
    const result: DescribeInstancesCommandOutput = await ec2ClientFor(region).send(
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
          region,
          jobId,
          launchTime: instance.LaunchTime ?? null,
          instanceType: instance.InstanceType ?? null,
        });
      }
    }
    nextToken = result.NextToken;
  } while (nextToken);
  return instances;
}
