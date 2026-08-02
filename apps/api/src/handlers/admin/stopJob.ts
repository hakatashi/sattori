import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { ExecutionDoesNotExist, SFNClient, StopExecutionCommand } from "@aws-sdk/client-sfn";
import { ADMIN_STOPPED_JOB_ERROR, isTerminalStatus } from "@sattori/shared";
import type { AdminStopJobResponse } from "@sattori/shared";
import { loadConfig, required } from "../../config.js";
import { terminateInstance } from "../../ec2.js";
import { error, json } from "../../http.js";
import { getJob, updateJobStatus } from "../../jobs.js";
import { buildExecutionArn } from "../../stepFunctions.js";

const sfn = new SFNClient({});

/**
 * POST /admin/jobs/{jobId}/stop
 * 暴走ジョブの緊急停止（管理画面。Issue #59）。認可はAPI Gateway側のLambda
 * Authorizerが担う。
 *
 * **順序が重要**: (1) Step Functions実行の停止 → (2) EC2インスタンスのterminate →
 * (3) ジョブを`failed`に確定、の順で行う。先にインスタンスをterminateすると、
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
  if (isTerminalStatus(job.status)) {
    return error(
      409,
      "job_already_terminal",
      `ジョブは既に終了しています（status: ${job.status}）`,
    );
  }

  const executionArn = buildExecutionArn(required("STATE_MACHINE_ARN"), jobId);
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

  let instanceTerminated = false;
  if (job.instanceId) {
    try {
      await terminateInstance(job.instanceId);
      instanceTerminated = true;
    } catch (err) {
      console.error(
        JSON.stringify({
          event: "admin_terminate_instance_failed",
          jobId,
          instanceId: job.instanceId,
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

  await updateJobStatus(config.jobsTable, jobId, "failed", ADMIN_STOPPED_JOB_ERROR);

  console.log(
    JSON.stringify({
      event: "admin_job_stopped",
      jobId,
      previousStatus: job.status,
      executionStopped,
      instanceTerminated,
    }),
  );

  const response: AdminStopJobResponse = {
    jobId,
    status: "failed",
    executionStopped,
    instanceTerminated,
  };
  return json(200, response);
};
