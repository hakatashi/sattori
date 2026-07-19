import { isTerminalStatus } from "@sattori/shared";
import { loadConfig } from "../../config.js";
import { terminateInstance } from "../../ec2.js";
import { getJob, updateJobStatus } from "../../jobs.js";
import { MAX_ATTEMPTS } from "../../retryPolicy.js";

/**
 * Step Functions の `Launch` ステートが失敗（Spot中断・タイムアウト・起動エラー等）
 * したときの Catch から、3分の待機（ステートマシン側の `WaitBeforeCheck`）を挟んで
 * 呼ばれる Lambda。
 * - Spot中断の早期失敗通知はワーカーの処理継続中に送られるため、待機中に処理が
 *   正常完了している（`status === "done"`）ことがある。その場合は何もせず
 *   `shouldRetry: false` を返す（インスタンスは自身の trap で既に shutdown 済み）。
 * - 未完了なら孤児化した可能性のある EC2 インスタンスを terminate する。
 * - まだリトライ余地があれば `shouldRetry: true` を返し、ステートマシン側で
 *   `Launch` へ戻る。無ければジョブを `failed` に確定させる
 *   （ワーカー自身が既に `failed` を書き込んでいる場合は上書きしない）。
 *
 * AWS API 呼び出し（terminate/updateJobStatus）の例外は握りつぶしてログのみに残す。
 * ここで例外を投げるとステートマシンの実行全体が失敗し、ジョブが非終端状態のまま
 * 固まってしまうため（CDK側の addRetry/addCatch も参照）。
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

  if (job?.status === "done") {
    console.log(
      JSON.stringify({
        event: "launch_failure_handled",
        jobId: event.jobId,
        attempt: event.attempt,
        shouldRetry: false,
        reason: "completed_during_grace_period",
      }),
    );
    return { shouldRetry: false };
  }

  if (job?.instanceId) {
    try {
      await terminateInstance(job.instanceId);
    } catch (err) {
      console.error(
        JSON.stringify({
          event: "terminate_instance_failed",
          jobId: event.jobId,
          instanceId: job.instanceId,
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    }
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
    try {
      await updateJobStatus(
        config.jobsTable,
        event.jobId,
        "failed",
        "録画に複数回失敗しました。時間をおいて再試行してください",
      );
    } catch (err) {
      console.error(
        JSON.stringify({
          event: "update_job_status_failed",
          jobId: event.jobId,
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  return { shouldRetry };
};
