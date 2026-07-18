import { isTerminalStatus } from "@sattori/shared";
import { loadConfig } from "../../config.js";
import { terminateInstance } from "../../ec2.js";
import { getJob, updateJobStatus } from "../../jobs.js";

/**
 * 初回+リトライ2回。Spot中断が連続しても際限なく課金され続けないための上限
 * （具体的な回数の指定はIssue上にないため、妥当な既定値として採用）。
 */
const MAX_ATTEMPTS = 3;

/**
 * Step Functions の `Launch` ステートが失敗（Spot中断・タイムアウト・起動エラー等）
 * したときの Catch から呼ばれる Lambda。
 * - 孤児化した可能性のある EC2 インスタンスを terminate する（タイムアウトで
 *   インスタンスが残り続けるのを防ぐ）。
 * - まだリトライ余地があれば `shouldRetry: true` を返し、ステートマシン側で
 *   `Launch` へ戻る。無ければジョブを `failed` に確定させる
 *   （ワーカー自身が既に `failed` を書き込んでいる場合は上書きしない）。
 */
export interface HandleFailureEvent {
  jobId: string;
  attempt: number;
}

export interface HandleFailureResult {
  shouldRetry: boolean;
}

export const handler = async (event: HandleFailureEvent): Promise<HandleFailureResult> => {
  const config = loadConfig();
  const job = await getJob(config.jobsTable, event.jobId);

  if (job?.instanceId) {
    await terminateInstance(job.instanceId);
  }

  const shouldRetry = event.attempt < MAX_ATTEMPTS;

  console.log(
    JSON.stringify({
      event: "launch_failure_handled",
      jobId: event.jobId,
      attempt: event.attempt,
      shouldRetry,
    }),
  );

  if (!shouldRetry && job && !isTerminalStatus(job.status)) {
    await updateJobStatus(
      config.jobsTable,
      event.jobId,
      "failed",
      "録画に複数回失敗しました。時間をおいて再試行してください",
    );
  }

  return { shouldRetry };
};
