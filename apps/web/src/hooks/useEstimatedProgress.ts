import { useEffect, useRef, useState } from "react";
import type { GetJobResponse, JobStatus } from "@sattori/shared";

/**
 * 録画フェーズはリプレイをそのまま等倍速で再生しながら録画するため、速度は常に1倍で確定している。
 * 変換フェーズはサーバースペックに応じて4〜6倍速程度で進む想定だが、個々のジョブでどの速度に
 * なるかは事前に分からないため、実測データが集まるまでの初期値として保守的な下限寄りの値を使う。
 */
const FIXED_RATE: Partial<Record<JobStatus, number>> = {
  recording: 1,
};
const DEFAULT_CONVERTING_RATE = 4;
const MIN_CONVERTING_RATE = 1;
const MAX_CONVERTING_RATE = 8;

/**
 * 変換フェーズの速度推定に使う最小経過秒数。ごく短い間隔の2点間で速度を計算すると、
 * ポーリングの取得タイミングのわずかなブレが速度の誤差として増幅されてしまうため、
 * ある程度時間が経ってから速度を確定させる。
 */
const MIN_RATE_SAMPLE_SECONDS = 2;

const TICK_INTERVAL_MS = 250;

interface PhaseStartSample {
  jobId: string;
  status: JobStatus;
  startProgress: number;
  startAt: number;
}

/**
 * ポーリング間隔（3秒）でしか届かないサーバーの進捗を、実時間経過をもとに補間して
 * 滑らかに見せる。新しいポーリング結果が届くたびにサーバー値へ同期するため、
 * 推定のずれが蓄積することはない。この表示は `replayInfo.estimatedDurationSeconds`
 * を超えないようクランプする以外は厳密である必要はない（UI上「進行中」であることが
 * 伝わればよい）。
 *
 * 変換フェーズは同じジョブでもサーバースペックによって速度が変わるため、固定倍率ではなく、
 * そのジョブの変換フェーズ開始時点から直近のポーリング結果までの実測進捗（サーバー時刻ベース）
 * から平均速度を逆算し、以降の補間に使う。十分な実測データが無い間は保守的な既定値で補間する。
 */
export function useEstimatedProgress(job: GetJobResponse | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  const phaseStartRef = useRef<PhaseStartSample | null>(null);
  const convertingRateRef = useRef(DEFAULT_CONVERTING_RATE);

  useEffect(() => {
    if (!job || job.progress === null) {
      return;
    }

    const start = phaseStartRef.current;
    const updatedAtMs = Date.parse(job.updatedAt);

    if (!start || start.jobId !== job.jobId || start.status !== job.status) {
      phaseStartRef.current = {
        jobId: job.jobId,
        status: job.status,
        startProgress: job.progress,
        startAt: updatedAtMs,
      };
      if (job.status === "converting") {
        convertingRateRef.current = DEFAULT_CONVERTING_RATE;
      }
      return;
    }

    if (job.status === "converting") {
      const elapsedSeconds = (updatedAtMs - start.startAt) / 1000;
      if (elapsedSeconds >= MIN_RATE_SAMPLE_SECONDS && job.progress > start.startProgress) {
        const observedRate = (job.progress - start.startProgress) / elapsedSeconds;
        convertingRateRef.current = Math.min(
          MAX_CONVERTING_RATE,
          Math.max(MIN_CONVERTING_RATE, observedRate),
        );
      }
    }
  }, [job?.jobId, job?.status, job?.progress, job?.updatedAt]);

  const rate = job
    ? (FIXED_RATE[job.status] ?? (job.status === "converting" ? convertingRateRef.current : undefined))
    : undefined;
  const active = job !== null && job.progress !== null && rate !== undefined;

  useEffect(() => {
    if (!active) {
      return;
    }
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), TICK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [active, job?.updatedAt]);

  if (!job || job.progress === null || rate === undefined) {
    return job?.progress ?? null;
  }

  const elapsedSeconds = Math.max(0, (now - Date.parse(job.updatedAt)) / 1000);
  const estimated = job.progress + elapsedSeconds * rate;

  const cap = job.replayInfo?.estimatedDurationSeconds ?? null;
  return cap === null ? estimated : Math.min(estimated, cap);
}
