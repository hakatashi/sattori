import { isTerminalStatus } from "@sattori/shared";
import { loadConfig } from "../../config.js";
import { findJobInstanceIds, terminateInstance } from "../../ec2.js";
import { releaseHomeWorkerAssignment } from "../../homeWorker.js";
import { getJob, updateJobStatus } from "../../jobs.js";
import { MAX_ATTEMPTS } from "../../retryPolicy.js";

/**
 * Step Functions の `Launch` ステートが失敗（Spot中断・タイムアウト・起動エラー等）
 * したときの Catch から、3分の待機（ステートマシン側の `WaitBeforeCheck`）を挟んで
 * 呼ばれる Lambda。
 * - Spot中断の早期失敗通知はワーカーの処理継続中に送られるため、待機中に処理が
 *   正常完了している（`status === "done"`）ことがある。その場合は何もせず
 *   `shouldRetry: false` を返す（インスタンスは自身の trap で既に shutdown 済み）。
 * - 未完了なら孤児化した可能性のある EC2 インスタンスを terminate し、自宅ワーカー
 *   （Issue #49）への割り当て・オファーを解除する。
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

  // 自宅ワーカー（Issue #49）への割り当てを解除する。EC2に対する`TerminateInstances`
  // と対になる後始末で、`assignedWorkerId`を消すことで走っているデーモンは次の
  // ジョブハートビート（条件付き更新）でclaimの取り消しに気づきコンテナを止める。
  // オファー中のまま`Launch`がタイムアウト/クラッシュしたケースも同時に掃除できる
  // （期限切れのオファーがGSIに残り続けるのを防ぐ）。
  if (job) {
    try {
      await releaseHomeWorkerAssignment(config.jobsTable, event.jobId);
    } catch (err) {
      console.error(
        JSON.stringify({
          event: "release_home_worker_failed",
          jobId: event.jobId,
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  // terminate対象は `JobRecord.instanceId` だけに頼らず、タグ(`sattori:jobId`)からも
  // 引く（Issue #23）。`Launch` は `CreateFleet` の**後**に `instanceId` を書くため、
  // 書き込む前にLambdaが死ぬとレコードには何も残らず、起動済みのインスタンスが
  // 誰にもterminateされないまま課金され続ける。タグは作成時に付くのでこの窓が無い。
  // 前の試行のterminateに失敗して複数台生き残っている場合もまとめて拾える。
  // 検索自体の失敗は握りつぶす（記録済みinstanceIdでの終了処理は続けられるし、
  // 取りこぼしても定期掃除（`handlers/sweepOrphanInstances.ts`）が最後の網になる）。
  const instanceIds = new Set<string>();
  if (job?.instanceId) {
    instanceIds.add(job.instanceId);
  }
  try {
    for (const instanceId of await findJobInstanceIds(event.jobId)) {
      instanceIds.add(instanceId);
    }
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "find_job_instances_failed",
        jobId: event.jobId,
        message: err instanceof Error ? err.message : String(err),
      }),
    );
  }

  for (const instanceId of instanceIds) {
    try {
      await terminateInstance(instanceId);
    } catch (err) {
      console.error(
        JSON.stringify({
          event: "terminate_instance_failed",
          jobId: event.jobId,
          instanceId,
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
