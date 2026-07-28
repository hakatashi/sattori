import { useEffect, useState } from "react";
import type { GetJobResponse, JobStatus } from "@sattori/shared";

/**
 * フェーズごとの進捗が実時間に対して伸びる速度（倍率）。
 * 録画フェーズはリプレイをそのまま等倍速で再生しながら録画するため1倍。
 * 変換フェーズはサーバースペックに応じて4〜6倍速程度で進む想定だが、この推定表示が
 * 実際にサーバーから取得する進捗を追い越さないよう、下限に近い保守的な値を使う。
 */
const PROGRESS_RATE: Partial<Record<JobStatus, number>> = {
  recording: 1,
  converting: 4,
};

const TICK_INTERVAL_MS = 250;

/**
 * ポーリング間隔（3秒）でしか届かないサーバーの進捗を、直近のポーリング結果からの
 * 実時間経過をもとに補間して滑らかに見せる。新しいポーリング結果が届くたびに
 * サーバー値へ同期するため、推定のずれが蓄積することはない。この表示は
 * `replayInfo.estimatedDurationSeconds` を超えないようクランプする以外は
 * 厳密である必要はない（UI上「進行中」であることが伝わればよい）。
 */
export function useEstimatedProgress(job: GetJobResponse | null): number | null {
  const rate = job ? PROGRESS_RATE[job.status] : undefined;
  const active = job !== null && job.progress !== null && rate !== undefined;

  const [now, setNow] = useState(() => Date.now());

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
