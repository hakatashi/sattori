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
  /** 難易度ごとの速度の上書き（`replayInfo.difficulty`が一致したときだけ使う。`realtime`の段のみ）。 */
  speedByDifficulty?: Readonly<Record<string, RecordingSpeed>>;
} & StepCapture &
  RecordingStepLimits;

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
 * th13の等倍の候補（Issue #79）。**1タイプしか挙げていないのは意図的**で、`.4xlarge`帯で検証したのは
 * `c7i.4xlarge`だけ（`docs/decisions/0042`のグループ化は`.2xlarge`帯に限る）。落ちはExtraで4.3%と
 * 数値上は基準外だが、視聴して許容範囲と判断した（touhou-recorder reports/100、`docs/decisions/0070`）。
 */
export const TH13_NATIVE_INSTANCE_TYPES = [
  "c7i.4xlarge", // 16vCPU/32GiB。reports/100実測でExtraの落ち4.3%
] as const;

/**
 * th13の1/2倍速の候補（Issue #79）。touhou-recorder reports/100で実機検証したのは`c7i.2xlarge`だけで、
 * `c7a.2xlarge`・`m7i.2xlarge`は`docs/decisions/0042`（`.2xlarge`帯実機検証済みグループ）の実績を根拠に
 * 足した。`c7i.2xlarge`の検証は落ち・スコア一致に加えて理論尺との比較も済ませた
 * （`docs/reports/2026-11-12-th13-recording-verification.md`）。
 */
export const TH13_SLOW_MOTION_INSTANCE_TYPES = [
  "c7i.2xlarge", // reports/100実測で1/2倍速の通常・Extraとも落ちなし
  "c7a.2xlarge", // 0042のグループ
  "m7i.2xlarge", // 0042のグループ
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

const HOME_NATIVE_STEP: HomeRecordingStep = {
  id: "home",
  kind: "home",
  captureMode: "realtime",
  speed: NATIVE_RECORDING_SPEED,
};

/**
 * CPUの段。`idPrefix`はCPUの段を2つ以上持つタイトルで段を区別するためのもの（既定の`cpu`は
 * 既存ジョブの記録と互換）。
 */
function cpuStep(
  instanceTypes: readonly string[],
  speed: RecordingSpeed,
  speedByDifficulty?: Readonly<Record<string, RecordingSpeed>>,
  idPrefix = "cpu",
): Ec2RecordingStep {
  return {
    id: `${idPrefix}:${PRIMARY_RECORDING_REGION}`,
    kind: "ec2",
    platform: "cpu",
    region: PRIMARY_RECORDING_REGION,
    instanceTypes,
    captureMode: "realtime",
    speed,
    ...(speedByDifficulty ? { speedByDifficulty } : {}),
  };
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
 * GPUの2倍速（th07は3倍速）で録り、GPUが無ければ等倍で自宅ワーカー→CPUへ落ちるタイトル。
 * 倍速は全タイトルで実用品質（touhou-recorder reports/84〜90）。th07は3倍速でも落ちが少ない。
 */
function speedupPlan(speed: RecordingSpeed, cpuTypes: readonly string[]): RecordingStep[] {
  return [...gpuSteps(speed), HOME_NATIVE_STEP, cpuStep(cpuTypes, NATIVE_RECORDING_SPEED)];
}

/**
 * 1280x960のタイトル（th15・th20）の`.2xlarge`帯のフレーム同期の段を飛ばす推定尺（秒）。th15を2xlargeで録ると総所要時間は
 * 尺の約2.2倍（2割遅ければ約2.5倍）になり、尺が約58〜68分を超えるとStep Functionsの150分に届くための保険
 * （Epic #399の点検では本番の過去ジョブ631件で該当0件）。
 */
export const FRAME_SYNC_1280X960_2XL_MAX_ESTIMATED_SECONDS = 55 * 60;

// フレーム同期の実時間効率（尺÷録画フェーズの実時間）。EC2は実験ジョブでの実測（上限解除後の平均速度を切り捨て、
// docs/reports/2026-11-22-th12-th15-frame-sync-ec2-verification.md）、自宅はこのマシンの2並列の実測
// （docs/reports/2026-11-22-worker-frame-sync-full-length-verification.md、th12 1.97倍・th15 0.59倍）。
const TH12_HOME = 2.0;
const TH12_2XL = 2.2;
const TH12_4XL = 3.1;
const TH15_HOME = 0.6;
const TH15_4XL = 1.7;
const TH15_2XL = 0.95;

/**
 * タイトルごとの段（先頭から順に試す）。録画非対応タイトルは持たない（`recordingPlanFor()`）。
 *
 * - th12・th15（Issue #390、`docs/decisions/0078`）: 自宅→CPU（フレーム同期）2段→GPU（実時間、最後の段）。
 *   th12（640x480）は`.2xlarge`帯が先、th15（1280x960）はCPU負荷が高いので`.4xlarge`帯が先。
 *   フレーム同期の段は速度が落ちるだけで品質は変わらない。
 * - th20: 2倍速はゲーム本体の単一スレッド性能が足りず落ちが等倍の16倍になるので等倍
 *   （reports/89）。GPUが無ければCPU低速録画（reports/91）。
 * - th06nc: D3D11描画。GPUが無ければ、MODでBC7テクスチャを展開したCPU描画の1/2倍速（reports/96・97、
 *   `docs/decisions/0067`）。Extraの高密度弾幕では描画が間引かれる（`docs/known-limitations.md`）。
 *   かつての最終段`g6.2xlarge`（`gpu-full:eu-south-2`、0064）はこの段に置き換えた。
 * - th13: GPUの段を持たない（GPUでの倍速は未検証）。自宅ワーカー→`c7i.4xlarge`の等倍→
 *   `.2xlarge`帯の1/2倍速（touhou-recorder reports/100、`docs/decisions/0070`）。
 */
export const RECORDING_PLANS: Readonly<Partial<Record<GameId, readonly RecordingStep[]>>> = {
  th06: speedupPlan(2, CPU_XLARGE_INSTANCE_TYPES),
  th06c: speedupPlan(2, CPU_XLARGE_INSTANCE_TYPES),
  th07: speedupPlan(3, CPU_XLARGE_INSTANCE_TYPES),
  th08: speedupPlan(2, CPU_XLARGE_INSTANCE_TYPES),
  th09: speedupPlan(2, CPU_XLARGE_INSTANCE_TYPES),
  th10: speedupPlan(2, CPU_XLARGE_INSTANCE_TYPES),
  th11: speedupPlan(2, CPU_2XLARGE_INSTANCE_TYPES),
  th12: [
    homeFrameSyncStep({ estimatedRealtimeFactor: TH12_HOME }),
    frameSyncCpuStep("2xl", { estimatedRealtimeFactor: TH12_2XL }),
    frameSyncCpuStep("4xl", { estimatedRealtimeFactor: TH12_4XL }),
    ...gpuSteps(2),
  ],
  th128: speedupPlan(2, CPU_2XLARGE_INSTANCE_TYPES),
  th15: [
    homeFrameSyncStep({ estimatedRealtimeFactor: TH15_HOME }),
    frameSyncCpuStep("4xl", { estimatedRealtimeFactor: TH15_4XL }),
    frameSyncCpuStep("2xl", {
      maxEstimatedDurationSeconds: FRAME_SYNC_1280X960_2XL_MAX_ESTIMATED_SECONDS,
      estimatedRealtimeFactor: TH15_2XL,
    }),
    ...gpuSteps(1),
  ],
  th20: [...gpuSteps(1), cpuStep(CPU_SLOW_MOTION_INSTANCE_TYPES, 1 / 2)],
  th06nc: [...gpuSteps(2), cpuStep(TH06NC_CPU_INSTANCE_TYPES, 1 / 2)],
  th13: [
    HOME_NATIVE_STEP,
    cpuStep(TH13_NATIVE_INSTANCE_TYPES, NATIVE_RECORDING_SPEED),
    cpuStep(TH13_SLOW_MOTION_INSTANCE_TYPES, 1 / 2, undefined, "cpu-slow"),
  ],
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
  replayInfo?: { difficulty: string | null } | null;
}): RecordingSpeed {
  const first = recordingPlanOf(job)[0];
  return first ? recordingSpeedForStep(first, job) : NATIVE_RECORDING_SPEED;
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
