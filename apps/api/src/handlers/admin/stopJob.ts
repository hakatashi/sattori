import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { ExecutionDoesNotExist, SFNClient, StopExecutionCommand } from "@aws-sdk/client-sfn";
import { ADMIN_STOPPED_JOB_ERROR, isTerminalStatus } from "@sattori/shared";
import type { AdminStopJobResponse } from "@sattori/shared";
import { loadConfig, required } from "../../config.js";
import { findJobInstanceIds, terminateInstance } from "../../ec2.js";
import { releaseHomeWorkerAssignment } from "../../homeWorker.js";
import { error, json } from "../../http.js";
import { getJob, updateJobStatus } from "../../jobs.js";
import { buildExecutionArn, getExecutionLiveness } from "../../stepFunctions.js";
import type { ExecutionLiveness } from "../../stepFunctions.js";

const sfn = new SFNClient({});

/**
 * POST /admin/jobs/{jobId}/stop
 * 暴走ジョブの緊急停止（管理画面。Issue #59）。認可はAPI Gateway側のLambda
 * Authorizerが担う。
 *
 * **停止可否は`JobRecord.status`ではなくStep Functions実行の生死で判定する**。
 * ワーカーは内部エラー時に`SendTaskFailure`より先に`status: "failed"`を書くため、
 * 「DynamoDB上は終端状態なのに実行は生きていて、最大10回まで新しいインスタンスを
 * 起動し続ける」窓が常に存在する（`stepFunctions.ts`の`getExecutionLiveness`参照）。
 * statusだけで弾くと、まさにこの機能が止めたい暴走ジョブを止められない。
 *
 * **順序が重要**: (1) Step Functions実行の停止 → (2) EC2インスタンスのterminate・
 * 自宅ワーカー（Issue #49）への割り当て解除 → (3) ジョブを`failed`に確定、の順で行う。先にインスタンスをterminateすると、
 * ワーカーからのtaskToken通知が永久に来なくなった実行がタスクタイムアウト(90分)後に
 * `HandleFailure`経由でリトライへ回り、**停止したはずのジョブが別インスタンスで
 * 再起動してしまう**（`infra/lib/sattori-stack.ts`のリトライループ）。
 *
 * 各段階の失敗はそこで打ち切って5xxを返し、ジョブ状態は書き換えない（実際には
 * 止まっていないのに`failed`と表示されるのが最も危険なため）。`StopExecution`は
 * 停止済みの実行に対しても成功する冪等なAPIなので、管理者はそのまま再実行できる。
 */
export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const config = loadConfig();
  const jobId = event.pathParameters?.jobId;
  if (!jobId) {
    return error(400, "invalid_request", "jobId が指定されていません");
  }

  const job = await getJob(config.jobsTable, jobId);
  if (!job) {
    return error(404, "not_found", "ジョブが見つかりません");
  }

  const executionArn = buildExecutionArn(required("STATE_MACHINE_ARN"), jobId);
  // 判定不能（DescribeExecutionの一時障害）のときは「止められる余地がある」側に倒す。
  // 止めるものが無いのに停止処理を走らせる害（冪等なStopExecutionと空振りの
  // terminate）より、止めたいものを止められない害の方がはるかに大きい。
  let liveness: ExecutionLiveness | "unknown";
  try {
    liveness = await getExecutionLiveness(sfn, executionArn);
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "admin_describe_execution_failed",
        jobId,
        executionArn,
        name: err instanceof Error ? err.name : undefined,
        message: err instanceof Error ? err.message : String(err),
      }),
    );
    liveness = "unknown";
  }

  /**
   * ジョブに紐づく「まだ生きている」インスタンスをタグから探す。`JobRecord.instanceId`
   * だけに頼らないのは、instanceIdをLaunch Lambdaが`CreateFleet`の**後**に書き込む
   * ため、起動直後のジョブでは上の`getJob`の時点でまだ未記録のことがあるため。
   * 取り逃すと、停止済み表示のまま孤児インスタンスが最大90分課金され続ける。
   * 検索の失敗自体は致命ではない（記録済みinstanceIdでの終了処理は続けられる）ので、
   * 例外にせず`failed`フラグで返す。
   */
  const lookupLiveInstances = async (): Promise<{ ids: string[]; failed: boolean }> => {
    try {
      return { ids: await findJobInstanceIds(jobId), failed: false };
    } catch (err) {
      console.error(
        JSON.stringify({
          event: "admin_describe_instances_failed",
          jobId,
          name: err instanceof Error ? err.name : undefined,
          message: err instanceof Error ? err.message : String(err),
        }),
      );
      return { ids: [], failed: true };
    }
  };

  const instancesBeforeStop = await lookupLiveInstances();

  // 「ジョブも終端・実行も生きていない・生きたインスタンスも無い」ときだけ、止める
  // ものが無いとして拒否する。生存インスタンスまで見るのは、`StopExecution`は成功
  // したがterminateに失敗して502を返した後の再実行を弾かないため（実行はもう
  // 終わっているので、生きたインスタンスだけが停止対象として残る）。逆に非終端の
  // まま固まったジョブ（statusが`recording`のまま実行だけ消えている等）は
  // 停止＝`failed`への確定に意味があるので通す。
  const nothingToStop =
    (liveness === "finished" || liveness === "absent") &&
    instancesBeforeStop.ids.length === 0 &&
    !instancesBeforeStop.failed;
  if (isTerminalStatus(job.status) && nothingToStop) {
    return error(
      409,
      "job_already_terminal",
      `ジョブは既に終了しています（status: ${job.status}）`,
    );
  }

  let executionStopped = false;
  try {
    await sfn.send(
      new StopExecutionCommand({
        executionArn,
        error: "AdminStopped",
        cause: ADMIN_STOPPED_JOB_ERROR,
      }),
    );
    executionStopped = true;
  } catch (err) {
    if (!(err instanceof ExecutionDoesNotExist)) {
      console.error(
        JSON.stringify({
          event: "admin_stop_execution_failed",
          jobId,
          executionArn,
          name: err instanceof Error ? err.name : undefined,
          message: err instanceof Error ? err.message : String(err),
        }),
      );
      return error(
        502,
        "stop_execution_failed",
        "Step Functions実行の停止に失敗しました。ジョブの状態は変更していません",
      );
    }
    // 実行がまだ存在しない（pendingのまま起動していない）、または履歴保持期間切れ。
    // 止めるべきものが無いだけなので、インスタンス終了と状態確定へ進む。
  }

  // タグ検索は`StopExecution`の後にもう一度行う。Step Functionsは実行中のLambda
  // 呼び出しをキャンセルしないため、停止を要求した後に`CreateFleet`が完了して
  // インスタンスが生まれることがあるため。記録済みのinstanceIdも対象に含める
  // （`DescribeInstances`は結果整合で、起動直後のインスタンスが一時的に見えない
  // ことがある）。既に終了済みのインスタンスへの`TerminateInstances`は冪等な
  // 空振りで済むので、対象を広めに取ることのコストは無い。
  const instancesAfterStop = await lookupLiveInstances();
  const instanceIds = new Set([...instancesBeforeStop.ids, ...instancesAfterStop.ids]);
  if (job.instanceId) {
    instanceIds.add(job.instanceId);
  }

  let instanceTerminated = false;
  for (const instanceId of instanceIds) {
    try {
      await terminateInstance(instanceId);
      instanceTerminated = true;
    } catch (err) {
      console.error(
        JSON.stringify({
          event: "admin_terminate_instance_failed",
          jobId,
          instanceId,
          name: err instanceof Error ? err.name : undefined,
          message: err instanceof Error ? err.message : String(err),
        }),
      );
      return error(
        502,
        "terminate_instance_failed",
        "EC2インスタンスの終了に失敗しました。Step Functions実行は停止済みのため、時間をおいて再度停止を実行してください",
      );
    }
  }

  // 自宅ワーカー（Issue #49）への割り当ても解除する。EC2の`TerminateInstances`と
  // 同じ位置づけの後始末で、`assignedWorkerId`が消えるとデーモンは次のジョブ
  // ハートビート（条件付き更新）でclaimの取り消しに気づき、コンテナを停止する。
  // 失敗を握りつぶすと「停止済み表示のまま自宅で録画が走り続ける」ことになるため、
  // terminate失敗時と同様に502で打ち切り、ジョブ状態は書き換えない。
  let homeWorkerReleased = false;
  try {
    await releaseHomeWorkerAssignment(config.jobsTable, jobId);
    homeWorkerReleased = job.assignedWorkerId !== undefined;
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "admin_release_home_worker_failed",
        jobId,
        name: err instanceof Error ? err.name : undefined,
        message: err instanceof Error ? err.message : String(err),
      }),
    );
    return error(
      502,
      "release_home_worker_failed",
      "自宅ワーカーへの割り当て解除に失敗しました。Step Functions実行は停止済みのため、時間をおいて再度停止を実行してください",
    );
  }

  // ここまでの間にワーカーが完走している可能性がある（例: `converting`のジョブを
  // 停止した直後に720pのアップロードが終わり、`done`とdoneAtが書かれて完了メールも
  // 飛ぶ）。無条件に上書きすると「完了メールは届いたのに画面はfailed」という最悪の
  // 食い違いになるため、`done`でない場合のみ`failed`を書く（handleFailure.tsが
  // 同じ競合に対して行っているガードと同じ方針）。
  const statusUpdated = await updateJobStatus(
    config.jobsTable,
    jobId,
    "failed",
    ADMIN_STOPPED_JOB_ERROR,
    { unlessDone: true },
  );

  console.log(
    JSON.stringify({
      event: "admin_job_stopped",
      jobId,
      previousStatus: job.status,
      executionLiveness: liveness,
      executionStopped,
      terminatedInstanceIds: [...instanceIds],
      homeWorkerReleased,
      statusUpdated,
    }),
  );

  const response: AdminStopJobResponse = {
    jobId,
    status: statusUpdated ? "failed" : "done",
    executionStopped,
    instanceTerminated,
    homeWorkerReleased,
  };
  return json(200, response);
};
