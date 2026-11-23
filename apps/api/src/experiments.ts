import {
  estimateJobCost,
  initialCaptureMode,
  isRecordingSpeed,
  isSupportedGame,
  NATIVE_RECORDING_SPEED,
  vcpusForInstanceType,
} from "@sattori/shared";
import type {
  AdminCreateExperimentRequest,
  AdminExperimentResult,
  ExperimentSpec,
  GameId,
  JobRecord,
  RecordingStep,
  ReplayInfo,
} from "@sattori/shared";
import { REPLAY_KEY_PATTERN } from "./uploads.js";

/** 検証用ECRのイメージタグ（Dockerのタグ文法のうち、UserDataのシェルへ安全に埋め込める範囲）。 */
export const IMAGE_TAG_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

/** EC2のインスタンスタイプ（例: `c7i.4xlarge`、`g6f.2xlarge`）。 */
const INSTANCE_TYPE_PATTERN = /^[a-z][a-z0-9-]*\.[a-z0-9]+$/;

const MAX_INSTANCE_TYPES = 10;
const MAX_NOTE_LENGTH = 500;

/** リクエストの検証結果。成功時はリプレイの出どころ（`sourceJobId`か`replayKey`＋`game`）も返す。 */
export type ParsedExperimentRequest =
  | {
      ok: true;
      spec: ExperimentSpec;
      source: { sourceJobId: string } | { replayKey: string; game: GameId };
      options: { watermark: boolean; th10BugfixMarisaB: boolean };
    }
  | { ok: false; message: string };

/**
 * 実験ジョブの段のid。通常の段（`cpu:eu-south-2`など）と混ざらないよう`experiment:`を前置する。
 * 同じジョブの中でしか使わないので、一意性は気にしなくてよい。
 */
export function experimentStepId(step: Pick<RecordingStep, "kind"> & { region?: string; platform?: string }): string {
  return step.kind === "home" ? "experiment:home" : `experiment:${step.platform}:${step.region}`;
}

function fail(message: string): ParsedExperimentRequest {
  return { ok: false, message };
}

/**
 * `POST /admin/experiments`のボディを検証して`ExperimentSpec`へ変換する。
 *
 * - 管理者向けなので、本番の段の配列に無いインスタンスタイプ・速度の組み合わせも許す（それが検証の目的）。
 *   ただし**実在しない形・シェルに埋め込めない値・起動できない組み合わせ**は弾く。
 * - GPUの段のインスタンスタイプは`GPU_INSTANCE_TYPE_VCPUS`（GPU vCPUリースの会計）に載っているものだけ。
 *   新しいGPUタイプを試すときは、先にそこへ足す。
 * - 検証用イメージ（`workerImageTag`）は、一次リージョンのEC2の段でだけ使える（`docs/decisions/0075`）。
 */
export function parseExperimentRequest(
  body: unknown,
  regions: { primary: string; gpuFallback: string | null },
): ParsedExperimentRequest {
  if (typeof body !== "object" || body === null) {
    return fail("リクエストボディが不正です");
  }
  const req = body as Partial<AdminCreateExperimentRequest>;

  let source: { sourceJobId: string } | { replayKey: string; game: GameId };
  if (typeof req.sourceJobId === "string" && req.sourceJobId !== "") {
    if (req.replayKey !== undefined || req.game !== undefined) {
      return fail("sourceJobId と replayKey/game は同時に指定できません");
    }
    source = { sourceJobId: req.sourceJobId };
  } else {
    if (typeof req.replayKey !== "string" || !REPLAY_KEY_PATTERN.test(req.replayKey)) {
      return fail("sourceJobId か、replays/<uuid>.rpy 形式の replayKey を指定してください");
    }
    if (typeof req.game !== "string" || !isSupportedGame(req.game as GameId)) {
      return fail("replayKey を指定するときは対応タイトルの game が必要です");
    }
    source = { replayKey: req.replayKey, game: req.game as GameId };
  }

  const stepReq = req.step;
  if (typeof stepReq !== "object" || stepReq === null) {
    return fail("step は必須です");
  }
  if (stepReq.captureMode !== "realtime" && stepReq.captureMode !== "frameSync") {
    return fail("step.captureMode は realtime か frameSync です");
  }
  let speed = stepReq.speed ?? NATIVE_RECORDING_SPEED;
  if (!isRecordingSpeed(speed)) {
    return fail("step.speed が不正です（1・2・3・4のいずれか）");
  }
  if (stepReq.captureMode === "frameSync") {
    if (speed !== NATIVE_RECORDING_SPEED) {
      return fail("frameSync の段の speed は 1 固定です");
    }
    speed = NATIVE_RECORDING_SPEED;
  }

  const workerImageTag = req.workerImageTag;
  if (workerImageTag !== undefined && (typeof workerImageTag !== "string" || !IMAGE_TAG_PATTERN.test(workerImageTag))) {
    return fail("workerImageTag が不正です（英数字・_・.・-、128文字以内）");
  }
  if (req.note !== undefined && (typeof req.note !== "string" || req.note.length > MAX_NOTE_LENGTH)) {
    return fail(`note は${MAX_NOTE_LENGTH}文字以内の文字列です`);
  }

  let step: RecordingStep;
  if (stepReq.kind === "home") {
    if (workerImageTag !== undefined) {
      return fail("自宅ワーカーの段では検証用イメージ（workerImageTag）を使えません");
    }
    step = {
      id: experimentStepId({ kind: "home" }),
      kind: "home",
      ...(stepReq.captureMode === "frameSync"
        ? { captureMode: "frameSync" as const, speed: 1 as const }
        : { captureMode: "realtime" as const, speed }),
    } as RecordingStep;
  } else if (stepReq.kind === "ec2") {
    if (stepReq.platform !== "cpu" && stepReq.platform !== "gpu") {
      return fail("step.platform は cpu か gpu です");
    }
    const allowedRegions =
      stepReq.platform === "gpu"
        ? [regions.primary, ...(regions.gpuFallback ? [regions.gpuFallback] : [])]
        : [regions.primary];
    if (typeof stepReq.region !== "string" || !allowedRegions.includes(stepReq.region)) {
      return fail(`step.region は ${allowedRegions.join("・")} のいずれかです（${stepReq.platform}）`);
    }
    if (workerImageTag !== undefined && stepReq.region !== regions.primary) {
      return fail(
        `検証用イメージは一次リージョン（${regions.primary}）でしか使えません（フォールバック先へは複製しません）`,
      );
    }
    const types = stepReq.instanceTypes;
    if (
      !Array.isArray(types) ||
      types.length === 0 ||
      types.length > MAX_INSTANCE_TYPES ||
      !types.every((type) => typeof type === "string" && INSTANCE_TYPE_PATTERN.test(type))
    ) {
      return fail(`step.instanceTypes は1〜${MAX_INSTANCE_TYPES}個のインスタンスタイプです`);
    }
    if (stepReq.platform === "gpu" && !types.every((type) => vcpusForInstanceType(type) !== null)) {
      return fail(
        "GPUの段のインスタンスタイプは GPU_INSTANCE_TYPE_VCPUS（packages/shared/src/gpuQueue.ts）に載っているものだけです",
      );
    }
    step = {
      id: experimentStepId({ kind: "ec2", platform: stepReq.platform, region: stepReq.region }),
      kind: "ec2",
      platform: stepReq.platform,
      region: stepReq.region,
      instanceTypes: [...types],
      ...(stepReq.captureMode === "frameSync"
        ? { captureMode: "frameSync" as const, speed: 1 as const }
        : { captureMode: "realtime" as const, speed }),
    } as RecordingStep;
  } else {
    return fail("step.kind は home か ec2 です");
  }

  return {
    ok: true,
    spec: {
      step,
      ...(workerImageTag !== undefined ? { workerImageTag } : {}),
      ...(req.note !== undefined && req.note !== "" ? { note: req.note } : {}),
    },
    source,
    options: {
      watermark: req.options?.watermark !== false,
      th10BugfixMarisaB: req.options?.th10BugfixMarisaB === true,
    },
  };
}

/** 実験ジョブのレコードを組み立てる（`queued`で作り、直ちにStep Functionsを起動する）。 */
export function buildExperimentJob(input: {
  jobId: string;
  now: Date;
  spec: ExperimentSpec;
  game: GameId;
  replayKey: string;
  replayInfo: ReplayInfo | null;
  estimatedDurationSeconds: number | null;
  options: { watermark: boolean; th10BugfixMarisaB: boolean };
}): JobRecord {
  const timestamp = input.now.toISOString();
  const experiment = { experiment: input.spec };
  return {
    jobId: input.jobId,
    game: input.game,
    replayKey: input.replayKey,
    status: "queued",
    options: {
      watermark: input.options.watermark,
      th10BugfixMarisaB: input.options.th10BugfixMarisaB,
      th06ncHighResolution: false,
      recordingSpeed: input.spec.step.speed,
      captureMode: initialCaptureMode({ game: input.game, ...experiment }),
    },
    outputPath: null,
    outputPath720p: null,
    outputBytes: null,
    outputBytes720p: null,
    error: null,
    errorCode: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    launchedAt: null,
    doneAt: null,
    // 実験ジョブは完了メールを送らない（`sendCompletionEmail.ts`はemailが無いジョブを飛ばす）。
    email: null,
    pendingExpiresAt: null,
    workerKind: null,
    instanceId: null,
    instanceType: null,
    availabilityZone: null,
    spotPricePerHour: null,
    estimatedDurationSeconds: input.estimatedDurationSeconds,
    progress: null,
    uploadTotalBytes: null,
    previewImagePath: null,
    posterImagePath: null,
    replayInfo: input.replayInfo,
    retriedToJobId: null,
    retriedFromJobId: null,
    language: "ja",
    desyncDetected: null,
    timedOut: null,
    ...experiment,
  };
}

/**
 * 実験ジョブ1件の結果。検証レポート用に、品質の判定値・速度・課金時間をまとめる。
 * `wallClockSeconds`は`launchedAt`から終了までで、リトライ間の待機（3分）を含むため
 * リトライしたジョブでは過大になる（コスト推定の`billedSeconds`と同じ性質、`cost.ts`）。
 */
export function toExperimentResult(job: JobRecord, now: Date = new Date()): AdminExperimentResult {
  const experiment = job.experiment;
  const cost = estimateJobCost(job, now);
  const endedAt = job.doneAt ?? (job.status === "failed" ? job.updatedAt : null);
  const wallClockSeconds =
    job.launchedAt !== null && endedAt !== null
      ? Math.max(0, (Date.parse(endedAt) - Date.parse(job.launchedAt)) / 1000)
      : null;
  const duration = job.estimatedDurationSeconds;
  return {
    jobId: job.jobId,
    game: job.game,
    status: job.status,
    createdAt: job.createdAt,
    note: experiment?.note ?? null,
    workerImageTag: experiment?.workerImageTag ?? null,
    stepId: job.recordingStepId ?? experiment?.step.id ?? "",
    captureMode: job.options.captureMode ?? "realtime",
    speed: job.options.recordingSpeed ?? NATIVE_RECORDING_SPEED,
    workerKind: job.workerKind,
    instanceType: job.instanceType,
    availabilityZone: job.availabilityZone,
    workerRegion: job.workerRegion ?? null,
    estimatedDurationSeconds: duration,
    wallClockSeconds,
    wallClockToDurationRatio:
      wallClockSeconds !== null && duration !== null && duration > 0 ? wallClockSeconds / duration : null,
    desyncDetected: job.desyncDetected,
    timedOut: job.timedOut,
    error: job.error,
    errorCode: job.errorCode,
    estimatedCostUsd: cost.totalUsd,
    billedSeconds: cost.billedSeconds,
  };
}
