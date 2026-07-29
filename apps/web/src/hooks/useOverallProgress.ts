import { useEffect, useRef, useState } from "react";
import type { GetJobResponse, JobStatus } from "@sattori/shared";
import {
  computeOverallPercent,
  computePhaseBudgets,
  computeRemainingMinutes,
  isPhaseOverrun,
  type PhaseBudgets,
} from "./jobProgressBudget.ts";

/** JobProgress.tsx の STATUS_STEP と同じ丸め（全体進捗のフェーズ後退検知に使う）。 */
const STATUS_STEP: Record<JobStatus, number> = {
  pending: 0,
  queued: 0,
  launching: 1,
  recording: 2,
  converting: 3,
  done: 4,
  failed: 4,
};

const TICK_INTERVAL_MS = 250;

export interface OverallProgress {
  /** 0-100。failed時は呼び出し側で使わない想定。 */
  percent: number;
  /** 残り分数(切り上げ)。不明・リトライ疑い・estimatedDurationSeconds無しなら null。 */
  remainingMinutes: number | null;
  /** STATUS_STEP後退 or 悲観バジェット大幅超過を検知した場合 true。 */
  retrySuspected: boolean;
}

interface LaunchingStartSample {
  jobId: string;
  startAtMs: number;
}

interface MaxStepSample {
  jobId: string;
  maxStep: number;
}

interface RetrySuspectedSample {
  jobId: string;
  suspected: boolean;
}

function computeElapsedSeconds(params: {
  status: JobStatus;
  launchingElapsedSeconds: number;
  phaseProgressSeconds: number | null;
  budgets: PhaseBudgets;
}): number {
  const { status, launchingElapsedSeconds, phaseProgressSeconds, budgets } = params;
  switch (status) {
    case "pending":
    case "queued":
      return 0;
    case "launching":
      return Math.min(launchingElapsedSeconds, budgets.launching);
    case "recording":
      return budgets.launching + Math.min(phaseProgressSeconds ?? 0, budgets.recording);
    case "converting":
    case "failed":
      return (
        budgets.launching +
        budgets.recording +
        Math.min(phaseProgressSeconds ?? 0, budgets.converting)
      );
    case "done":
      return budgets.total;
  }
}

function budgetForStatus(status: JobStatus, budgets: PhaseBudgets): number | null {
  switch (status) {
    case "launching":
      return budgets.launching;
    case "recording":
      return budgets.recording;
    case "converting":
      return budgets.converting;
    default:
      return null;
  }
}

/**
 * pending〜doneまでの全体進捗(%)と、悲観的な見積もりに基づく残り時間(分)を計算する。
 * サーバーはStep Functionsのattempt番号(何回目の試行か)を一切露出しないため、リトライが
 * 起きたかどうかは正確には分からない。そのため、以下2つの間接シグナルのいずれかを
 * 「リトライが起きた可能性が高い」とみなし、その場合はETA(残り分数)を隠して呼び出し側で
 * 代替メッセージに切り替えられるようにする（誤検知・見逃しがあり得る前提の設計）。
 *   A. 同一ジョブ内でSTATUS_STEPが後退した(例: recording→launching。Step Functionsの
 *      リトライはDynamoDBのstatusを巻き戻さずクラッシュ時点のまま残すため、3分の待機を
 *      経て突然前のフェーズに戻ったように見える)。
 *   B. 現フェーズの経過時間が悲観バジェットを大幅(PHASE_OVERRUN_FACTOR倍)に超過した。
 */
export function useOverallProgress(
  job: GetJobResponse | null,
  phaseProgressSeconds: number | null,
): OverallProgress {
  const [now, setNow] = useState(() => Date.now());
  const launchingStartRef = useRef<LaunchingStartSample | null>(null);
  const prevStatusRef = useRef<{ jobId: string; status: JobStatus } | null>(null);
  const maxStepRef = useRef<MaxStepSample | null>(null);
  const retrySuspectedRef = useRef<RetrySuspectedSample | null>(null);

  useEffect(() => {
    if (!job) {
      return;
    }

    const prev = prevStatusRef.current;
    const isNewJob = !prev || prev.jobId !== job.jobId;
    const enteredLaunching = isNewJob
      ? job.status === "launching"
      : prev.status !== "launching" && job.status === "launching";

    if (isNewJob) {
      maxStepRef.current = { jobId: job.jobId, maxStep: STATUS_STEP[job.status] };
      retrySuspectedRef.current = { jobId: job.jobId, suspected: false };
      launchingStartRef.current = null;
    }

    if (enteredLaunching) {
      launchingStartRef.current = { jobId: job.jobId, startAtMs: Date.parse(job.updatedAt) };
    }

    if (!isNewJob && job.status !== "failed") {
      const step = STATUS_STEP[job.status];
      const maxStep = maxStepRef.current;
      if (maxStep && maxStep.jobId === job.jobId) {
        if (step < maxStep.maxStep) {
          retrySuspectedRef.current = { jobId: job.jobId, suspected: true };
        }
        maxStep.maxStep = Math.max(maxStep.maxStep, step);
      }
    }

    prevStatusRef.current = { jobId: job.jobId, status: job.status };
  }, [job?.jobId, job?.status, job?.updatedAt]);

  const active = job !== null && job.status === "launching";

  useEffect(() => {
    if (!active) {
      return;
    }
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), TICK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [active]);

  if (!job) {
    return { percent: 0, remainingMinutes: null, retrySuspected: false };
  }

  const budgets = computePhaseBudgets(job.replayInfo?.estimatedDurationSeconds ?? null);
  const launchingStart = launchingStartRef.current;
  const launchingElapsedSeconds =
    launchingStart && launchingStart.jobId === job.jobId
      ? Math.max(0, (now - launchingStart.startAtMs) / 1000)
      : 0;

  const elapsedSeconds = computeElapsedSeconds({
    status: job.status,
    launchingElapsedSeconds,
    phaseProgressSeconds,
    budgets,
  });

  const done = job.status === "done";
  const percent = computeOverallPercent(elapsedSeconds, budgets.total, done);

  const stickyRetrySuspected =
    retrySuspectedRef.current?.jobId === job.jobId && retrySuspectedRef.current.suspected;
  const overrunRetrySuspected = isPhaseOverrun(
    budgetForStatus(job.status, budgets),
    job.status === "launching" ? launchingElapsedSeconds : (phaseProgressSeconds ?? 0),
  );
  const retrySuspected = stickyRetrySuspected || overrunRetrySuspected;

  // estimatedDurationSecondsが不明なジョブはFALLBACK_ESTIMATED_DURATION_SECONDSという
  // 根拠の薄い仮の目盛りでバーを描画しているため、その数字に基づく「残り約○分」は主張しない。
  const hasReliableBudget = job.replayInfo?.estimatedDurationSeconds !== null &&
    job.replayInfo?.estimatedDurationSeconds !== undefined;
  const remainingMinutes =
    retrySuspected || !hasReliableBudget
      ? null
      : computeRemainingMinutes(elapsedSeconds, budgets.total);

  return { percent, remainingMinutes, retrySuspected };
}
