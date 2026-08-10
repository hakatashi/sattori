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

interface PhaseStartSample {
  jobId: string;
  status: JobStatus;
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
  phaseElapsedSeconds: number;
  phaseProgressSeconds: number | null;
  budgets: PhaseBudgets;
}): number {
  const { status, phaseElapsedSeconds, phaseProgressSeconds, budgets } = params;
  // 進捗(phaseProgressSeconds)はワーカーが報告する「コンテンツ秒数」で、バジェットは
  // 実時間。低速録画(Issue #68)ではこの2つの単位が2倍ずれるため、必ず換算してから
  // 突き合わせる(等倍録画では係数1で従来と同じ)。
  const wallClockPerContentSecond =
    budgets.recordingContent > 0 ? budgets.recording / budgets.recordingContent : 1;
  switch (status) {
    case "pending":
    case "queued":
      return 0;
    case "launching":
      return Math.min(phaseElapsedSeconds, budgets.launching);
    case "recording":
      return (
        budgets.launching +
        Math.min((phaseProgressSeconds ?? 0) * wallClockPerContentSecond, budgets.recording)
      );
    case "converting":
    case "failed": {
      // phaseProgressSecondsはconvertingでは「変換済みコンテンツ秒数
      // (0〜budgets.recordingContent)」であり、悲観バジェット
      // (budgets.converting = budgets.recordingContent/MIN_CONVERTING_RATE、
      // wall-clock換算で圧縮された値)とは単位が異なる。そのままminで比較すると、実際の変換が
      // まだ半分も終わっていない段階でbudgets.convertingに達してしまい、全体%が早期に頭打ちに
      // なる。実際の変換進捗率(content秒数ベース)をbudgets.convertingの持ち分に按分することで、
      // 変換の実進捗に応じて全体%が伸びるようにする。
      // 変換の対象は等倍に戻した後の動画なので、分母は実時間の`recording`ではなく
      // コンテンツ長の`recordingContent`である(低速録画でも変換の尺は変わらない)。
      const ratio = Math.min(1, (phaseProgressSeconds ?? 0) / budgets.recordingContent);
      return budgets.launching + budgets.recording + ratio * budgets.converting;
    }
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
 *   B. 現フェーズに入ってからの実経過時間(wall-clock、job.updatedAtがフェーズ遷移時点を示す
 *      ことを利用して計測)が、そのフェーズの悲観バジェットをPHASE_OVERRUN_FACTOR倍超過した。
 */
export function useOverallProgress(
  job: GetJobResponse | null,
  phaseProgressSeconds: number | null,
): OverallProgress {
  const [now, setNow] = useState(() => Date.now());
  const phaseStartRef = useRef<PhaseStartSample | null>(null);
  const prevStatusRef = useRef<{ jobId: string; status: JobStatus } | null>(null);
  const maxStepRef = useRef<MaxStepSample | null>(null);
  const retrySuspectedRef = useRef<RetrySuspectedSample | null>(null);

  useEffect(() => {
    if (!job) {
      return;
    }

    const prev = prevStatusRef.current;
    const isNewJob = !prev || prev.jobId !== job.jobId;
    const enteredNewPhase = isNewJob || prev.status !== job.status;

    if (isNewJob) {
      maxStepRef.current = { jobId: job.jobId, maxStep: STATUS_STEP[job.status] };
      retrySuspectedRef.current = { jobId: job.jobId, suspected: false };
    }

    if (enteredNewPhase) {
      phaseStartRef.current = {
        jobId: job.jobId,
        status: job.status,
        startAtMs: Date.parse(job.updatedAt),
      };
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

    // retrySuspectedRef/phaseStartRefはrefのミューテーションのため、それ自体は再レンダーを
    // 起こさない。ここで明示的に状態を更新し、このeffect内での判定結果が同じコミット内で
    // 即座に描画へ反映されるようにする(activeの値がフェーズ遷移前後で変化しない場合、後段の
    // ティック用effectだけには頼れないため)。
    setNow(Date.now());
  }, [job?.jobId, job?.status, job?.updatedAt]);

  // done/failed(終端状態)以外は、フェーズ開始からの実経過時間を追跡し続ける必要があるため
  // 常にティックさせる(launchingはprogressシグナルが無くこれが唯一の情報源、
  // recording/convertingはリトライ疑い判定Bの計測にも使うため)。
  const active = job !== null && job.status !== "done" && job.status !== "failed";

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

  const budgets = computePhaseBudgets(
    job.replayInfo?.estimatedDurationSeconds ?? null,
    // 低速録画(Issue #68)は録画フェーズに実時間で2倍かかる。これを渡さないと
    // 録画の途中でバジェットを使い切り、残り時間が消えたうえリトライ疑いを誤検知する。
    job.slowMotion,
  );
  const phaseStart = phaseStartRef.current;
  const phaseElapsedSeconds =
    phaseStart && phaseStart.jobId === job.jobId && phaseStart.status === job.status
      ? Math.max(0, (now - phaseStart.startAtMs) / 1000)
      : 0;

  const elapsedSeconds = computeElapsedSeconds({
    status: job.status,
    phaseElapsedSeconds,
    phaseProgressSeconds,
    budgets,
  });

  const done = job.status === "done";
  const percent = computeOverallPercent(elapsedSeconds, budgets.total, done);

  const stickyRetrySuspected =
    retrySuspectedRef.current?.jobId === job.jobId && retrySuspectedRef.current.suspected;
  const overrunRetrySuspected = isPhaseOverrun(budgetForStatus(job.status, budgets), phaseElapsedSeconds);
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
