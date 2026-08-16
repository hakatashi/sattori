import { isTerminalStatus } from "@sattori/shared";
import { loadConfig } from "../../config.js";
import { findJobInstanceIds, terminateInstance } from "../../ec2.js";
import { releaseHomeWorkerAssignment } from "../../homeWorker.js";
import { getJob, updateJobStatus } from "../../jobs.js";
import { MAX_ATTEMPTS, MAX_ATTEMPTS_DETERMINISTIC } from "../../retryPolicy.js";

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
 *   `Launch` へ戻る。リトライ余地の判定は失敗種別で分岐する（`isDeterministicFailure`
 *   参照）。無ければジョブを `failed` に確定させる。
 *
 * `:36` で読む `job` はこの関数の入口時点のスナップショットに過ぎず、その後の
 * terminate・割り当て解除に数秒〜十数秒かかる間にワーカーが完走して `done` を
 * 書けることがある（Issue #129）。そのため最終的な `failed` 書き込みは
 * `{ unlessDone: true }` を付けた原子的更新にし、スナップショットではなく
 * 書き込み時点の実際の状態で `done` を上書きしないことを保証する
 * （`admin/stopJob.ts` が同じ競合に対して行っているガードと同じ方針）。
 *
 * terminate・割り当て解除の例外は握りつぶしてログのみに残す（後始末が一部
 * 失敗してもリトライ判定・最終確定は続行する。取りこぼした孤児は定期掃除
 * `handlers/sweepOrphanInstances.ts` が最後の網になる）。一方で最終的な
 * `failed` 書き込みの例外は握りつぶさない —— ここが失敗するとジョブレコードが
 * 非終端のまま残ってしまうため、投げてステートマシン側の Lambda 呼び出しリトライ
 * （`handleFailureTask.addRetry`、CDK側）に委ねる。
 */
export interface HandleFailureEvent {
  jobId: string;
  attempt: number;
  /** Launch タスクの Catch で捕捉した失敗情報（`$.error`）。無ければ再試行可能側として扱う。 */
  error?: {
    Error?: string;
    Cause?: string;
  };
}

/** `worker/entrypoint.py` の `notify_task_result` がSpot中断時に付与する `cause` の接頭辞。
 * Spot中断は `SendTaskFailure` の `error` 自体は `WorkerFailed` と同じ値で送られるため
 * （通知経路が共通のため区別が無い）、`Error` だけでは見分けられず `Cause` を見る必要がある。 */
const SPOT_INTERRUPTED_CAUSE_PREFIX = "SpotInterrupted:";

/**
 * 再試行しても解決しない「決定的な失敗」かどうかを判定する（Issue #131）。
 * `worker/README.md` §13 の通り、デシンク等が原因の失敗は同一リプレイなら毎回
 * 同じ箇所で再現するため、フルの `MAX_ATTEMPTS` まで再試行しても時間とコストの
 * 浪費にしかならない。
 *
 * - `WorkerBootstrapFailure`（ECRログイン・docker起動などコンテナ起動前の失敗）
 * - `WorkerFailed` のうち、Spot中断由来ではないもの（ワーカーが内部で失敗を検知して
 *   `SendTaskFailure` を呼んだ場合。Spot中断も同じ `Error` 値で報告されるため
 *   `Cause` の接頭辞で除外する）
 *
 * それ以外（Spot中断・`States.Timeout`・`States.HeartbeatTimeout`・EC2起動時の
 * キャパシティ不足等）は再試行に意味がありうるため、決定的とは扱わない。
 */
function isDeterministicFailure(error: HandleFailureEvent["error"]): boolean {
  if (!error?.Error) {
    return false;
  }
  if (error.Error === "WorkerBootstrapFailure") {
    return true;
  }
  if (error.Error === "WorkerFailed") {
    return !(error.Cause ?? "").startsWith(SPOT_INTERRUPTED_CAUSE_PREFIX);
  }
  return false;
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

  const deterministic = isDeterministicFailure(event.error);
  const maxAttempts = deterministic ? MAX_ATTEMPTS_DETERMINISTIC : MAX_ATTEMPTS;
  const shouldRetry = event.attempt < maxAttempts;

  console.log(
    JSON.stringify({
      event: "launch_failure_handled",
      jobId: event.jobId,
      attempt: event.attempt,
      error: event.error?.Error,
      deterministic,
      maxAttempts,
      shouldRetry,
    }),
  );

  // ここは例外を握りつぶさない。失敗するとジョブレコードが非終端のまま残ってしまうため、
  // 投げてステートマシン側の Lambda 呼び出しリトライ（CDK側 `handleFailureTask.addRetry`）
  // に委ねる。`{ unlessDone: true }` は `job` がこの関数の入口時点のスナップショットである
  // ことに対する保険で、その後の後始末中にワーカーが完走して書いた `done` を上書きしない
  // （Issue #129）。
  if (!shouldRetry && job && !isTerminalStatus(job.status)) {
    await updateJobStatus(
      config.jobsTable,
      event.jobId,
      "failed",
      "録画に複数回失敗しました。時間をおいて再試行してください",
      { unlessDone: true, errorCode: "retries_exhausted" },
    );
  }

  return { shouldRetry };
};
