import type { GameId } from "./games.js";
import { SUPPORTED_GAME_IDS } from "./games.js";
import { NATIVE_RECORDING_SPEED } from "./recordingSpeed.js";
import type { RecordingSpeed } from "./recordingSpeed.js";

/**
 * 録画の段（フォールバック順序、Issue #317、`docs/decisions/0066`）。
 *
 * ジョブはタイトルごとの段の配列（`RECORDING_PLANS`）を先頭から順に試し、ワーカーを1台
 * 割り当てられた段で録画する。**録画速度・インスタンスタイプ・リージョン・GPUの要否はすべて
 * 段が決める**。フォールバック先を足す・入れ替える・速度を変えるときはこの配列を書き換えるだけで
 * 済むようにしてあるので、起動側（`apps/api`）に段やタイトルごとの分岐を書かないこと。
 *
 * ## 段を進める契機
 *
 * 使い切った段は`JobRecord.capacityExhaustedTargets`へ記録し、同じジョブでは二度と試さない
 * （`docs/decisions/0063`）。
 *
 * - EC2の段の全サブネット×全候補がSpot在庫の枯渇で失敗した（`handlers/sfn/launch.ts`）
 * - GPU vCPU枠を`GPU_QUEUE_STEP_SKIP_MINUTES`以上待った（`handlers/sfn/acquireGpuSlot.ts`）。
 *   GPUの段をまとめて記録する
 * - クォータ超過などが`GPU_QUOTA_STEP_SKIP_ATTEMPT`回目以降の試行でも続いた
 *   （`handlers/sfn/handleFailure.ts`）。同上
 *
 * 自宅ワーカーの段はclaimされなくても記録しない（リトライのたびにもう一度オファーする）。
 * 全段を使い切ったジョブは`capacity_exhausted`で失敗する。
 *
 * ## 配列の制約（`recordingPlan.test.ts`で守っている）
 *
 * - 段の`id`は配列の中で一意にする。デプロイの時点で走っているジョブの記録を読み違えないよう、
 *   既存の`id`の意味は変えないこと。
 * - **GPUの段はGPU以外の段より前に置く**。GPU vCPU枠のリースは`AcquireGpuSlot`ステートが
 *   最初の段についてだけ確保し、`Launch`はGPU以外の段へ進むときに返却するため。
 * - `region`は一次リージョン（CPU・GPUとも）か、GPUのフォールバック先リージョン（GPUのみ）。
 *   それ以外のリージョンにはLaunch Template・AMI・出力バケットが無い（`apps/api/src/ec2.ts`）。
 *
 * **インスタンスタイプ・録画速度の変更は必ず実機検証を経ること**（AGENTS.md §3）。
 * 2026-11-08時点の経路と費用は
 * `docs/reports/2026-11-08-recommended-speed-fallback-order-and-cost.md`。
 */
export type RecordingStep = HomeRecordingStep | Ec2RecordingStep;

/** 自宅ワーカーへのオファー（Issue #49）。GPUを持たない前提なのでCPU描画の段。 */
export interface HomeRecordingStep {
  id: string;
  kind: "home";
  speed: RecordingSpeed;
}

/** EC2 Spotの1段。全サブネット×候補タイプを1回の`CreateFleet`に渡す。 */
export interface Ec2RecordingStep {
  id: string;
  kind: "ec2";
  /** GPU系（GPU用Launch Template・`worker-gpu`イメージ・GPU vCPUリース）か。 */
  platform: "gpu" | "cpu";
  region: string;
  instanceTypes: readonly string[];
  speed: RecordingSpeed;
  /** 難易度ごとの速度の上書き（`replayInfo.difficulty`が一致したときだけ使う）。 */
  speedByDifficulty?: Readonly<Record<string, RecordingSpeed>>;
}

/** 一次リージョン（`AGENTS.md` §2）。 */
export const PRIMARY_RECORDING_REGION = "eu-south-2";

/** GPUのSpot在庫が一次リージョンで枯渇したときのフォールバック先（`docs/decisions/0061`）。 */
export const GPU_FALLBACK_RECORDING_REGION = "eu-north-1";

/**
 * CPU等倍（th06・th06c・th07・th08・th09・th10）の候補。4タイプともeu-south-2実機で検証済み
 * （touhou-recorder reports/42・43）。タイプごとに独立したSpotプールを持つため、1タイプだけだと
 * 枯渇時に起動できない（Issue #29）。「同スペック帯・同価格帯だから安全」とは限らない
 * （`z1d.xlarge`は高クロック特化ゆえに悪化した、AGENTS.md §3）。
 */
export const CPU_XLARGE_INSTANCE_TYPES = [
  "c7i.xlarge", // reports/42実測で重複フレーム率0.1〜0.2%、第一候補
  "c7a.xlarge", // reports/43実測で重複フレーム率1.4%
  "c7i-flex.xlarge", // reports/43実測で重複フレーム率5.0%
  "m7i.xlarge", // reports/43実測で重複フレーム率2.7%
] as const;

/**
 * CPU等倍（th11・th12・th128）の候補。`.xlarge`帯（4vCPU）ではゲームプレイ自体の処理落ち
 * （理論尺超過）が起きる（touhou-recorder reports/40・67・73）。3タイプは異なる2タイトルでの
 * 実証実績に基づく「`.2xlarge`帯実機検証済みグループ」（`docs/decisions/0042`）。
 */
export const CPU_2XLARGE_INSTANCE_TYPES = [
  "c7i.2xlarge", // th11 reports/42、th12 reports/67、th128 reports/73
  "c7a.2xlarge", // th11 reports/43、th12 2026-09-01実機検証
  "m7i.2xlarge", // th11 reports/43、th12 2026-09-01実機検証
] as const;

/**
 * CPU低速録画（th15・th20、Issue #316）の候補。**1タイプしか挙げていないのは意図的**で、
 * 他のタイプはこの構成で検証していない。`.2xlarge`帯は落ちが約3倍になる（reports/91）。
 */
export const CPU_SLOW_MOTION_INSTANCE_TYPES = [
  "c7i.4xlarge", // 16vCPU/32GiB。reports/91実測で配信版の落ち0.5〜0.8%
] as const;

/**
 * GPUの段の候補（`docs/decisions/0046`）。**`g6f.2xlarge`（NVIDIA L4の1/4スライス、8vCPU）のみ**。
 * 倍速録画は8vCPUでしか検証されておらず、4vCPUの`g6f.xlarge`ではゲーム本体とキャプチャ・
 * エンコードがCPUを奪い合い2倍速を維持できない（touhou-recorder reports/85、Issue #288）。
 */
export const GPU_INSTANCE_TYPES = [
  "g6f.2xlarge", // reports/81・89実測
] as const;

/**
 * th06ncのCPU低速録画の候補（BC7展開によるCPU描画、touhou-recorder reports/96・97）。**1タイプしか挙げて
 * いないのは意図的**で、`c7i.xlarge`は落ち11.2%でゲーム進行も遅れ、`c7i.4xlarge`はExtraでは良いが
 * Lunaticの終盤で`.2xlarge`より悪く単価が2倍（reports/97）。th15・th20の`c7i.4xlarge`とは別の判断。
 */
export const TH06NC_CPU_INSTANCE_TYPES = [
  "c7i.2xlarge", // 8vCPU。reports/97実測で720p 1/2倍速のLunatic全6面の落ち1.3%（Extraは7.6%）
] as const;

/** 一次・フォールバック先リージョンのGPUの段（`g6f.2xlarge`）。 */
function gpuSteps(speed: RecordingSpeed): Ec2RecordingStep[] {
  return [
    {
      id: `gpu:${PRIMARY_RECORDING_REGION}`,
      kind: "ec2",
      platform: "gpu",
      region: PRIMARY_RECORDING_REGION,
      instanceTypes: GPU_INSTANCE_TYPES,
      speed,
    },
    {
      id: `gpu:${GPU_FALLBACK_RECORDING_REGION}`,
      kind: "ec2",
      platform: "gpu",
      region: GPU_FALLBACK_RECORDING_REGION,
      instanceTypes: GPU_INSTANCE_TYPES,
      speed,
    },
  ];
}

const HOME_NATIVE_STEP: HomeRecordingStep = { id: "home", kind: "home", speed: NATIVE_RECORDING_SPEED };

function cpuStep(
  instanceTypes: readonly string[],
  speed: RecordingSpeed,
  speedByDifficulty?: Readonly<Record<string, RecordingSpeed>>,
): Ec2RecordingStep {
  return {
    id: `cpu:${PRIMARY_RECORDING_REGION}`,
    kind: "ec2",
    platform: "cpu",
    region: PRIMARY_RECORDING_REGION,
    instanceTypes,
    speed,
    ...(speedByDifficulty ? { speedByDifficulty } : {}),
  };
}

/**
 * GPUの2倍速（th07は3倍速）で録り、GPUが無ければ等倍で自宅ワーカー→CPUへ落ちるタイトル。
 * 倍速は全タイトルで実用品質（touhou-recorder reports/84〜90）。th07は3倍速でも落ちが少ない。
 */
function speedupPlan(speed: RecordingSpeed, cpuTypes: readonly string[]): RecordingStep[] {
  return [...gpuSteps(speed), HOME_NATIVE_STEP, cpuStep(cpuTypes, NATIVE_RECORDING_SPEED)];
}

/**
 * タイトルごとの段（先頭から順に試す）。録画非対応タイトルは持たない（`recordingPlanFor()`）。
 *
 * - th15: GPU描画（wined3d+OpenGL）でExtraの高負荷区間の処理落ちが解消する（reports/82）。
 *   GPUが無ければCPU低速録画。Extraは1/2倍速でも30Hzを維持できないので1/3倍速（reports/91）。
 * - th20: 2倍速はゲーム本体の単一スレッド性能が足りず落ちが等倍の16倍になるので等倍
 *   （reports/89）。GPUが無ければCPU低速録画（reports/91）。
 * - th06nc: D3D11描画。GPUが無ければ、MODでBC7テクスチャを展開したCPU描画の1/2倍速（reports/96・97、
 *   `docs/decisions/0067`）。Extraの高密度弾幕では描画が間引かれる（`docs/known-limitations.md`）。
 *   かつての最終段`g6.2xlarge`（`gpu-full:eu-south-2`、0064）はこの段に置き換えた。
 */
export const RECORDING_PLANS: Readonly<Partial<Record<GameId, readonly RecordingStep[]>>> = {
  th06: speedupPlan(2, CPU_XLARGE_INSTANCE_TYPES),
  th06c: speedupPlan(2, CPU_XLARGE_INSTANCE_TYPES),
  th07: speedupPlan(3, CPU_XLARGE_INSTANCE_TYPES),
  th08: speedupPlan(2, CPU_XLARGE_INSTANCE_TYPES),
  th09: speedupPlan(2, CPU_XLARGE_INSTANCE_TYPES),
  th10: speedupPlan(2, CPU_XLARGE_INSTANCE_TYPES),
  th11: speedupPlan(2, CPU_2XLARGE_INSTANCE_TYPES),
  th12: speedupPlan(2, CPU_2XLARGE_INSTANCE_TYPES),
  th128: speedupPlan(2, CPU_2XLARGE_INSTANCE_TYPES),
  th15: [...gpuSteps(2), cpuStep(CPU_SLOW_MOTION_INSTANCE_TYPES, 1 / 2, { Extra: 1 / 3 })],
  th20: [...gpuSteps(1), cpuStep(CPU_SLOW_MOTION_INSTANCE_TYPES, 1 / 2)],
  th06nc: [...gpuSteps(2), cpuStep(TH06NC_CPU_INSTANCE_TYPES, 1 / 2)],
};

/** タイトルの段。録画非対応タイトルは空配列（ジョブは作られない）。 */
export function recordingPlanFor(game: GameId): readonly RecordingStep[] {
  return RECORDING_PLANS[game] ?? [];
}

/** GPU系の段か（自宅ワーカーは常にCPU）。 */
export function isGpuStep(step: RecordingStep): boolean {
  return step.kind === "ec2" && step.platform === "gpu";
}

/** その段で録るときの録画速度（難易度の上書きを解決する）。 */
export function recordingSpeedForStep(
  step: RecordingStep,
  job: { replayInfo?: { difficulty: string | null } | null },
): RecordingSpeed {
  if (step.kind === "ec2" && step.speedByDifficulty) {
    const difficulty = job.replayInfo?.difficulty;
    const override = difficulty ? step.speedByDifficulty[difficulty] : undefined;
    if (override !== undefined) {
      return override;
    }
  }
  return step.speed;
}

/** 段をこのジョブで試さないか（管理設定による検証用の除外、`apps/api/src/recordingSteps.ts`）。 */
export type RecordingStepFilter = (step: RecordingStep) => boolean;

/** ジョブ・リトライが参照する段の状態。 */
export interface RecordingStepState {
  game: GameId;
  capacityExhaustedTargets?: string[];
  /**
   * 段の導入前に速度を落としたジョブの記録（`JobRecord.requestedRecordingSpeed`、0060・0064）。
   * これがあるジョブはGPUの段を使い切ったものとして扱う（デプロイを跨いで走っているジョブがGPUへ戻らないように）。
   */
  requestedRecordingSpeed?: unknown;
}

/** まだ試せる段（使い切った段と`excluded`が真の段を除く）。 */
export function remainingRecordingSteps(
  job: RecordingStepState,
  excluded: RecordingStepFilter = () => false,
): RecordingStep[] {
  const exhausted = job.capacityExhaustedTargets ?? [];
  const legacyFellBack = job.requestedRecordingSpeed !== undefined;
  return recordingPlanFor(job.game).filter(
    (step) => !exhausted.includes(step.id) && !excluded(step) && !(legacyFellBack && isGpuStep(step)),
  );
}

/** 次に試す段。全段を使い切っていれば null。 */
export function currentRecordingStep(
  job: RecordingStepState,
  excluded?: RecordingStepFilter,
): RecordingStep | null {
  return remainingRecordingSteps(job, excluded)[0] ?? null;
}

/**
 * GPUの段を飛ばせるなら、飛ばす段の`id`を返す（GPU枠の長時間待ち・クォータ超過、Issue #289・#316）。
 * 次に試す段がGPUで、その後ろにGPU以外の段が残っているときだけ。飛ばせなければ空配列
 * （th06ncのようにGPU以外の段が無いタイトルは、待つか失敗するしかない）。
 */
export function skippableGpuStepIds(job: RecordingStepState, excluded?: RecordingStepFilter): string[] {
  const remaining = remainingRecordingSteps(job, excluded);
  const first = remaining[0];
  if (!first || !isGpuStep(first) || !remaining.some((step) => !isGpuStep(step))) {
    return [];
  }
  return remaining.filter(isGpuStep).map((step) => step.id);
}

/**
 * ジョブ作成時（`POST /magic-links`）に`options.recordingSpeed`へ入れる速度。最初の段の速度で、
 * 実際に割り当てた段の速度は`Launch`が書き直す。GPU待ち行列のETA・ジョブページの推定に使う。
 */
export function initialRecordingSpeed(job: {
  game: GameId;
  replayInfo?: { difficulty: string | null } | null;
}): RecordingSpeed {
  const first = recordingPlanFor(job.game)[0];
  return first ? recordingSpeedForStep(first, job) : NATIVE_RECORDING_SPEED;
}

/** 自宅ワーカーの段を持つタイトル（`home-worker/src/config.ts`の既定・拒否リスト）。 */
export const HOME_WORKER_GAME_IDS: readonly GameId[] = SUPPORTED_GAME_IDS.filter((game) =>
  recordingPlanFor(game).some((step) => step.kind === "home"),
);

/**
 * GPU枠をこの分数以上待ったジョブは、GPU以外の段が残っていればGPUの段を飛ばす（Issue #289・#316）。
 * 待ち行列のタイムアウト（`GPU_QUEUE_MAX_WAIT_MINUTES`、120分）より十分短くする——30分待って
 * なお枠が空かないなら、等倍・低速でもすぐ録り始めたほうが早く仕上がる見込みが高い。
 */
export const GPU_QUEUE_STEP_SKIP_MINUTES = 30;

/**
 * GPUの段の起動がクォータ超過（`VcpuLimitExceeded`等）などで失敗したとき、それがこの回数目以降の
 * 試行ならGPUの段を飛ばす（Issue #289・#316）。1試行あたり`WaitBeforeCheck`の3分を挟むため、
 * 3なら最初の起動から約6〜9分で見切る。Spot在庫の枯渇は待たずに段を進めるので、この定数は使わない。
 */
export const GPU_QUOTA_STEP_SKIP_ATTEMPT = 3;
