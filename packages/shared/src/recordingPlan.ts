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
 * - GPUの段は配列のどこに置いてもよい（先頭でも最後でも動く、`docs/decisions/0073`）。GPU vCPU枠の
 *   リースは、次に試すEC2の段（自宅の段を除く）がGPUのとき`AcquireGpuSlot`が確保する。CPUの段を
 *   使い切ってからGPUの段へ来た場合は、`Launch`が`GpuLeaseRequired`で失敗してリトライ経由で
 *   `AcquireGpuSlot`へ戻す。
 * - `region`は一次リージョン（CPU・GPUとも）か、GPUのフォールバック先リージョン（GPUのみ）。
 *   それ以外のリージョンにはLaunch Template・AMI・出力バケットが無い（`apps/api/src/ec2.ts`）。
 *
 * **インスタンスタイプ・録画速度の変更は必ず実機検証を経ること**（AGENTS.md §3）。
 * 2026-11-08時点の経路と費用は
 * `docs/reports/2026-11-08-recommended-speed-fallback-order-and-cost.md`。
 */
export type RecordingStep = HomeRecordingStep | Ec2RecordingStep;

/**
 * 録画方式（Epic #399、Issue #387）。
 *
 * - `realtime`: ゲームを実時間で動かし、外からx11grabで取り込む（従来の方式）。`speed`で倍速・低速にする。
 * - `frameSync`: ゲームのPresentごとにMODがバックバッファを書き出し、タイマーを仮想化して1フレーム
 *   1/60秒ずつ進める。倍率という概念が無いので`speed`は1固定で、`FPS_LIMIT_TARGET_HZ`とは併用できない。
 *
 * ワーカーへは`CAPTURE_MODE=frame_sync`として渡す（`apps/api/src/workerEnv.ts`）。
 */
export type CaptureMode = "realtime" | "frameSync";

/** 型で`frameSync`と`speed !== 1`の組み合わせを作れなくする。 */
export type StepCapture =
  | { captureMode: "realtime"; speed: RecordingSpeed }
  | { captureMode: "frameSync"; speed: 1 };

/** 段の種類によらない任意の設定。 */
export interface RecordingStepLimits {
  /**
   * リプレイの推定尺（`JobRecord.estimatedDurationSeconds`）がこれを超えるジョブは、この段を飛ばす
   * （`remainingRecordingSteps()`）。1280x960タイトルの2xlarge段のように、尺の長いリプレイでは
   * 上限に当たりうる段への保険。推定尺が不明（null）のジョブは飛ばさない。
   */
  maxEstimatedDurationSeconds?: number;
  /**
   * 実時間効率（1.0なら尺と同じ時間で録れる）。フロントのETA用で、frameSyncの段はCPUの性能で
   * 速度が決まるため段ごとに実測値を入れる。未設定ならETAは従来の見積もり（`recordingSpeed`）。
   */
  estimatedRealtimeFactor?: number;
}

/** 自宅ワーカーへのオファー（Issue #49）。GPUを持たない前提なのでCPU描画の段。 */
export type HomeRecordingStep = {
  id: string;
  kind: "home";
} & StepCapture &
  RecordingStepLimits;

/** EC2 Spotの1段。全サブネット×候補タイプを1回の`CreateFleet`に渡す。 */
export type Ec2RecordingStep = {
  id: string;
  kind: "ec2";
  /** GPU系（GPU用Launch Template・`worker-gpu`イメージ・GPU vCPUリース）か。 */
  platform: "gpu" | "cpu";
  region: string;
  instanceTypes: readonly string[];
} & StepCapture &
  RecordingStepLimits;

/** 一次リージョン（`AGENTS.md` §2）。 */
export const PRIMARY_RECORDING_REGION = "eu-south-2";

/** GPUのSpot在庫が一次リージョンで枯渇したときのフォールバック先（`docs/decisions/0061`）。 */
export const GPU_FALLBACK_RECORDING_REGION = "eu-north-1";

/**
 * フレーム同期（`captureMode: "frameSync"`）の`.2xlarge`帯の候補。フレーム同期ではインスタンスタイプの違いが
 * 録画の品質に影響せず**速度だけが変わる**ので（Epic #399のユーザー判断、`docs/decisions/0078`）、新しい
 * タイプを足すときの実機検証は要らない（必要なら簡単な速度検証だけ）。c7i/c7a/m7iの`.2xlarge`は運用実績が
 * ある（`docs/decisions/0042`）。タイプごとに独立したSpotプールを持つので、1タイプだけだと枯渇時に起動できない。
 */
export const FRAME_SYNC_2XLARGE_INSTANCE_TYPES = [
  "c7i.2xlarge", // 8vCPU。docs/reports/2026-11-22-th12-th15-frame-sync-ec2-verification.md で実測
  "c7a.2xlarge", // 運用実績あり（0042）
  "m7i.2xlarge", // 運用実績あり（0042）
] as const;

/** フレーム同期の`.4xlarge`帯の候補。`c7i.4xlarge`はth13・th15・th20での運用実績がある。 */
export const FRAME_SYNC_4XLARGE_INSTANCE_TYPES = [
  "c7i.4xlarge", // 16vCPU/32GiB。docs/reports/2026-11-22-th12-th15-frame-sync-ec2-verification.md で実測
] as const;

/**
 * GPUの段の候補（`docs/decisions/0046`）。**`g6f.2xlarge`（NVIDIA L4の1/4スライス、8vCPU）のみ**。
 * 倍速録画は8vCPUでしか検証されておらず、4vCPUの`g6f.xlarge`ではゲーム本体とキャプチャ・
 * エンコードがCPUを奪い合い2倍速を維持できない（touhou-recorder reports/85、Issue #288）。
 */
export const GPU_INSTANCE_TYPES = [
  "g6f.2xlarge", // reports/81・89実測
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
      captureMode: "realtime",
      speed,
    },
    {
      id: `gpu:${GPU_FALLBACK_RECORDING_REGION}`,
      kind: "ec2",
      platform: "gpu",
      region: GPU_FALLBACK_RECORDING_REGION,
      instanceTypes: GPU_INSTANCE_TYPES,
      captureMode: "realtime",
      speed,
    },
  ];
}

/** 自宅ワーカーへのオファー（フレーム同期）。 */
function homeFrameSyncStep(limits: RecordingStepLimits = {}): HomeRecordingStep {
  return { id: "home", kind: "home", captureMode: "frameSync", speed: 1, ...limits };
}

/** フレーム同期のCPUの段（`.2xlarge`帯・`.4xlarge`帯）。段の`id`は帯ごとに固定（既存ジョブの記録と互換にする）。 */
function frameSyncCpuStep(tier: "2xl" | "4xl", limits: RecordingStepLimits = {}): Ec2RecordingStep {
  return {
    id: `cpu-fs-${tier}:${PRIMARY_RECORDING_REGION}`,
    kind: "ec2",
    platform: "cpu",
    region: PRIMARY_RECORDING_REGION,
    instanceTypes: tier === "2xl" ? FRAME_SYNC_2XLARGE_INSTANCE_TYPES : FRAME_SYNC_4XLARGE_INSTANCE_TYPES,
    captureMode: "frameSync",
    speed: 1,
    ...limits,
  };
}

/**
 * 1280x960のタイトル（th15・th20）の`.2xlarge`帯のフレーム同期の段を飛ばす推定尺（秒）。th15を2xlargeで録ると総所要時間は
 * 尺の約2.2倍（2割遅ければ約2.5倍）になり、尺が約58〜68分を超えるとStep Functionsの150分に届くための保険
 * （Epic #399の点検では本番の過去ジョブ631件で該当0件）。
 */
export const FRAME_SYNC_1280X960_2XL_MAX_ESTIMATED_SECONDS = 55 * 60;

/** フレーム同期の実時間効率（尺÷録画フェーズの実時間）。段ごとの値は下の表。 */
interface FrameSyncFactors {
  home: number;
  twoXl: number;
  fourXl: number;
}

// 実時間効率は、EC2は実験ジョブでの実測（上限解除後の平均速度を切り捨て。th12・th15は
// docs/reports/2026-11-22-th12-th15-frame-sync-ec2-verification.md、それ以外の640x480は
// docs/reports/2026-11-22-th06-to-th13-frame-sync-ec2-verification.md、th20・th06ncは
// docs/reports/2026-11-23-th20-th06nc-frame-sync-ec2-verification.md、th14は
// docs/reports/2026-11-23-th14-frame-sync-ec2-verification.md）、自宅はこのマシンの2並列の実測
// （docs/reports/2026-11-22-worker-frame-sync-full-length-verification.md）。
const TH12_FACTORS: FrameSyncFactors = { home: 2.0, twoXl: 2.2, fourXl: 3.1 };
const TH06_FACTORS: FrameSyncFactors = { home: 3.1, twoXl: 3.9, fourXl: 5.2 };
const TH06C_FACTORS: FrameSyncFactors = { home: 2.2, twoXl: 3.5, fourXl: 4.5 };
const TH07_FACTORS: FrameSyncFactors = { home: 2.8, twoXl: 3.8, fourXl: 5.3 };
const TH08_FACTORS: FrameSyncFactors = { home: 3.2, twoXl: 3.7, fourXl: 5.5 };
const TH09_FACTORS: FrameSyncFactors = { home: 2.3, twoXl: 2.8, fourXl: 4.5 };
const TH10_FACTORS: FrameSyncFactors = { home: 2.7, twoXl: 3.3, fourXl: 4.7 };
const TH11_FACTORS: FrameSyncFactors = { home: 1.9, twoXl: 2.3, fourXl: 3.5 };
const TH128_FACTORS: FrameSyncFactors = { home: 1.7, twoXl: 2.0, fourXl: 2.8 };
const TH13_FACTORS: FrameSyncFactors = { home: 1.3, twoXl: 1.9, fourXl: 2.7 };
const TH06NC_FACTORS: FrameSyncFactors = { home: 0.9, twoXl: 1.2, fourXl: 1.7 };
const TH14_FACTORS: FrameSyncFactors = { home: 0.6, twoXl: 0.75, fourXl: 1.1 };
const TH15_FACTORS: FrameSyncFactors = { home: 0.6, twoXl: 0.95, fourXl: 1.7 };
const TH20_FACTORS: FrameSyncFactors = { home: 0.6, twoXl: 0.95, fourXl: 1.5 };

/**
 * 640x480のタイトルと th06nc（720p）の計画: 自宅 → `.2xlarge`帯 → `c7i.4xlarge`（どちらもフレーム同期）→ GPU（実時間、
 * 最後の段）。`.2xlarge`帯のほうが実測の推定コストが安いので先（th12・th06〜th13・th06ncで確認）。`gpuSpeed`を省くと
 * GPUの段を持たない（th13: GPUでの倍速が未検証、Issue #374）。
 */
function frameSyncLowResPlan(factors: FrameSyncFactors, gpuSpeed?: RecordingSpeed): RecordingStep[] {
  return [
    homeFrameSyncStep({ estimatedRealtimeFactor: factors.home }),
    frameSyncCpuStep("2xl", { estimatedRealtimeFactor: factors.twoXl }),
    frameSyncCpuStep("4xl", { estimatedRealtimeFactor: factors.fourXl }),
    ...(gpuSpeed === undefined ? [] : gpuSteps(gpuSpeed)),
  ];
}

/**
 * 1280x960のタイトル（th14・th15・th20）の計画: 自宅 → `c7i.4xlarge` → `.2xlarge`帯（推定尺が長いと飛ばす。いずれもフレーム
 * 同期）→ GPU（実時間1倍速、最後の段）。CPU負荷が高く、`.4xlarge`のほうが速度が単価の比より速いので`.4xlarge`が先。
 * `gpu: false`ならGPUの段を持たない（th14: GPUでの録画が未検証、Issue #80）。
 */
function frameSync1280Plan(factors: FrameSyncFactors, options: { gpu: boolean } = { gpu: true }): RecordingStep[] {
  return [
    homeFrameSyncStep({ estimatedRealtimeFactor: factors.home }),
    frameSyncCpuStep("4xl", { estimatedRealtimeFactor: factors.fourXl }),
    frameSyncCpuStep("2xl", {
      maxEstimatedDurationSeconds: FRAME_SYNC_1280X960_2XL_MAX_ESTIMATED_SECONDS,
      estimatedRealtimeFactor: factors.twoXl,
    }),
    ...(options.gpu ? gpuSteps(1) : []),
  ];
}

/**
 * タイトルごとの段（先頭から順に試す）。録画非対応タイトルは持たない（`recordingPlanFor()`）。
 *
 * - th06・th06c・th07・th08・th09・th10・th11・th12・th128・th13（640x480、Issue #390、`docs/decisions/0078`）:
 *   自宅→`.2xlarge`帯→`c7i.4xlarge`（どちらもフレーム同期）→GPU（実時間、最後の段。th07は3倍速、th13は無し、
 *   他は2倍速）。フレーム同期の段は速度が落ちるだけで品質は変わらない。
 * - th06nc（720p、D3D11描画。MODがBC7テクスチャを展開するCPU描画）: 640x480と同じ形（`.2xlarge`帯が先）。GPUの段は
 *   実時間の2倍速。かつての実時間のCPU1/2倍速・`g6.2xlarge`の段は廃止した（#391）（`docs/decisions/0081`）。
 * - th15・th20（1280x960）: CPU負荷が高いので`.4xlarge`帯が先。GPUの段は実時間の1倍速。th20の実時間CPU低速録画は
 *   置き換えた（`docs/decisions/0081`）。
 * - th14（1280x960）: th15・th20と同じ形だがGPUの段は持たない（GPUインスタンスでの録画が未検証、Issue #80）。
 */
export const RECORDING_PLANS: Readonly<Partial<Record<GameId, readonly RecordingStep[]>>> = {
  th06: frameSyncLowResPlan(TH06_FACTORS, 2),
  th06c: frameSyncLowResPlan(TH06C_FACTORS, 2),
  th07: frameSyncLowResPlan(TH07_FACTORS, 3),
  th08: frameSyncLowResPlan(TH08_FACTORS, 2),
  th09: frameSyncLowResPlan(TH09_FACTORS, 2),
  th10: frameSyncLowResPlan(TH10_FACTORS, 2),
  th11: frameSyncLowResPlan(TH11_FACTORS, 2),
  th12: frameSyncLowResPlan(TH12_FACTORS, 2),
  th128: frameSyncLowResPlan(TH128_FACTORS, 2),
  th13: frameSyncLowResPlan(TH13_FACTORS),
  th14: frameSync1280Plan(TH14_FACTORS, { gpu: false }),
  th15: frameSync1280Plan(TH15_FACTORS),
  th20: frameSync1280Plan(TH20_FACTORS),
  th06nc: frameSyncLowResPlan(TH06NC_FACTORS, 2),
};

/** タイトルの段。録画非対応タイトルは空配列（ジョブは作られない）。 */
export function recordingPlanFor(game: GameId): readonly RecordingStep[] {
  return RECORDING_PLANS[game] ?? [];
}

/**
 * ジョブの段の配列。実験ジョブ（`JobRecord.experiment`、Epic #399・Issue #397、`docs/decisions/0075`）は
 * 指定された1段だけ、通常のジョブはタイトルの段（`recordingPlanFor()`）。**段を読む処理は
 * `recordingPlanFor(job.game)`ではなくこれを使うこと**（実験ジョブが自分の段を使えなくなる）。
 */
export function recordingPlanOf(job: {
  game: GameId;
  experiment?: { step: RecordingStep };
}): readonly RecordingStep[] {
  return job.experiment ? [job.experiment.step] : recordingPlanFor(job.game);
}

/** GPU系の段か（自宅ワーカーは常にCPU）。 */
export function isGpuStep(step: RecordingStep): boolean {
  return step.kind === "ec2" && step.platform === "gpu";
}

/** その段で録るときの録画速度。 */
export function recordingSpeedForStep(step: RecordingStep): RecordingSpeed {
  return step.speed;
}

/** 段をこのジョブで試さないか（管理設定による検証用の除外、`apps/api/src/recordingSteps.ts`）。 */
export type RecordingStepFilter = (step: RecordingStep) => boolean;

/** ジョブ・リトライが参照する段の状態。 */
export interface RecordingStepState {
  game: GameId;
  /** 実験ジョブの指定。あれば段はこの1段だけ（`recordingPlanOf()`）。 */
  experiment?: { step: RecordingStep };
  capacityExhaustedTargets?: string[];
  /**
   * 段の導入前に速度を落としたジョブの記録（`JobRecord.requestedRecordingSpeed`、0060・0064）。
   * これがあるジョブはGPUの段を使い切ったものとして扱う（デプロイを跨いで走っているジョブがGPUへ戻らないように）。
   */
  requestedRecordingSpeed?: unknown;
  /** リプレイの推定尺（秒）。`maxEstimatedDurationSeconds`を持つ段の判定に使う。 */
  estimatedDurationSeconds?: number | null;
}

/** 推定尺が段の`maxEstimatedDurationSeconds`を超えているか（推定尺が不明なら false）。 */
function exceedsMaxDuration(step: RecordingStep, job: RecordingStepState): boolean {
  const limit = step.maxEstimatedDurationSeconds;
  const estimated = job.estimatedDurationSeconds;
  return limit !== undefined && typeof estimated === "number" && estimated > limit;
}

/**
 * 推定尺が長すぎて飛ばす段（`maxEstimatedDurationSeconds`）のうち、まだ使い切りとして記録されていない
 * もの。`Launch`が`capacityExhaustedTargets`へ記録し、理由をログに残す。
 */
export function durationSkippedStepIds(job: RecordingStepState): string[] {
  const exhausted = job.capacityExhaustedTargets ?? [];
  return recordingPlanOf(job)
    .filter((step) => !exhausted.includes(step.id) && exceedsMaxDuration(step, job))
    .map((step) => step.id);
}

/** まだ試せる段（使い切った段・`excluded`が真の段・推定尺が上限を超える段を除く）。 */
export function remainingRecordingSteps(
  job: RecordingStepState,
  excluded: RecordingStepFilter = () => false,
): RecordingStep[] {
  const exhausted = job.capacityExhaustedTargets ?? [];
  const legacyFellBack = job.requestedRecordingSpeed !== undefined;
  return recordingPlanOf(job).filter(
    (step) =>
      !exhausted.includes(step.id) &&
      !excluded(step) &&
      !(legacyFellBack && isGpuStep(step)) &&
      !exceedsMaxDuration(step, job),
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
 * 次に試すEC2の段（自宅ワーカーの段は飛ばして数える）。自宅の段はclaimされなくても使い切りに
 * ならず先頭に残り続けるため、`currentRecordingStep()`ではGPU vCPUリースの要否を判定できない
 * （`docs/decisions/0073`）。EC2の段が残っていなければ null。
 */
export function nextEc2Step(
  job: RecordingStepState,
  excluded?: RecordingStepFilter,
): Ec2RecordingStep | null {
  const step = remainingRecordingSteps(job, excluded).find((candidate) => candidate.kind === "ec2");
  return step?.kind === "ec2" ? step : null;
}

/**
 * GPUの段を飛ばせるなら、飛ばす段の`id`を返す（GPU枠の長時間待ち・クォータ超過、Issue #289・#316）。
 * 次に試すEC2の段がGPUで、**最初のGPUの段より後ろ**にGPU以外の段が残っているときだけ。飛ばせなければ
 * 空配列（後ろにGPU以外の段が無い——GPUの段が最後の計画や、後ろの段を使い切ったジョブは、待つか
 * 失敗するしかない。前にある自宅の段は飛ばしても戻るだけで意味が無いので数えない）。
 */
export function skippableGpuStepIds(job: RecordingStepState, excluded?: RecordingStepFilter): string[] {
  const remaining = remainingRecordingSteps(job, excluded);
  const firstEc2 = remaining.find((step) => step.kind === "ec2");
  if (!firstEc2 || !isGpuStep(firstEc2)) {
    return [];
  }
  const afterFirstGpu = remaining.slice(remaining.indexOf(firstEc2));
  if (!afterFirstGpu.some((step) => !isGpuStep(step))) {
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
  experiment?: { step: RecordingStep };
}): RecordingSpeed {
  const first = recordingPlanOf(job)[0];
  return first ? recordingSpeedForStep(first) : NATIVE_RECORDING_SPEED;
}

/** ジョブの録画オプションから録画方式を読む（欠損・不正値は`realtime`）。 */
export function captureModeOf(options: { captureMode?: unknown } | undefined): CaptureMode {
  return options?.captureMode === "frameSync" ? "frameSync" : "realtime";
}

/** ジョブ作成時に`options.captureMode`へ入れる値（最初の段の録画方式。`initialRecordingSpeed()`と対）。 */
export function initialCaptureMode(job: {
  game: GameId;
  experiment?: { step: RecordingStep };
}): CaptureMode {
  return recordingPlanOf(job)[0]?.captureMode ?? "realtime";
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
