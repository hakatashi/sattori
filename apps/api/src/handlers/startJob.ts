import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import type { StartJobResponse } from "@sattori/shared";
import { loadConfig, required } from "../config.js";
import { error, json } from "../http.js";
import { getJob, JobAlreadyStartedError, startPendingJob, updateJobStatus } from "../jobs.js";
import { INITIAL_ATTEMPT } from "../retryPolicy.js";
import { getSettings } from "../settings.js";
import type { LaunchTaskEvent } from "./sfn/launch.js";

const sfn = new SFNClient({});

/**
 * POST /jobs/{jobId}/start
 * ジョブページ（メールのリンク先）を開いた際に呼ぶ、録画起動要求。
 * 認可はjobIdのみで行う（jobId自体がメールを確認しないと分からない秘密値。Issue #9）。
 * 同一jobIdに対して複数回呼ばれても録画が起動するのは最初の1回だけになるよう、
 * "pending"→"queued"の遷移をDynamoDBの条件付き更新で原子的に行う。既に起動済み
 * （statusがpending以外）なら、再起動はせず現在の状態をそのまま返す（冪等）。
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

  if (job.status !== "pending") {
    // 起動済み（2回目以降のアクセス）。現在の状態をそのまま返すだけでよい。
    const response: StartJobResponse = { jobId: job.jobId, status: job.status };
    return json(200, response);
  }

  if (job.pendingExpiresAt && new Date(job.pendingExpiresAt).getTime() < Date.now()) {
    return error(
      410,
      "job_expired",
      "受付期限が切れています。お手数ですがもう一度リプレイをアップロードしてください",
    );
  }

  // キルスイッチ（Issue #14／#130）。`POST /magic-links`側にしか無かったため、既に
  // 発行済みのpendingジョブ（最大24時間有効）は受付停止中でも起動できてしまっていた
  // （REL-1）。ここではジョブをpendingのまま据え置き、startPendingJob()を呼ばずに
  // 503を返す——受付再開後に同じリンクを開けば起動できるため、ユーザーの損失はゼロ。
  // 月間コストガードは全件Scanを要しユーザー体験とのトレードオフが生じるため、
  // ここでは見ない（キルスイッチのみ）。
  const settings = await getSettings(config.settingsTable);
  if (!settings.acceptingNewJobs) {
    return error(
      503,
      "service_paused",
      "現在、新規録画の受付を一時的に停止しています。しばらくしてから再度お試しください。",
    );
  }

  try {
    await startPendingJob(config.jobsTable, jobId);
  } catch (err) {
    if (err instanceof JobAlreadyStartedError) {
      // 並行リクエスト（多重クリック等）が先に起動を確定させた。
      // `startPendingJob` が条件チェック失敗時点の状態を返してくれるため、
      // 追加の GetItem 往復なしで冪等に返せる（ここでStep Functionsを
      // 再度起動してはならない）。
      const response: StartJobResponse = { jobId, status: err.currentStatus ?? "queued" };
      return json(200, response);
    }
    throw err;
  }

  try {
    const input: Pick<LaunchTaskEvent, "jobId" | "attempt"> = {
      jobId,
      attempt: INITIAL_ATTEMPT,
    };
    await sfn.send(
      new StartExecutionCommand({
        stateMachineArn: required("STATE_MACHINE_ARN"),
        name: jobId,
        input: JSON.stringify(input),
      }),
    );
  } catch (err) {
    // StartExecution 失敗の原因を切り分けられるよう、例外の詳細を CloudWatch Logs
    // に残す（DynamoDB の error は簡潔な文言のみ保持）。
    console.error(
      JSON.stringify({
        event: "start_execution_failed",
        jobId,
        name: err instanceof Error ? err.name : undefined,
        message: err instanceof Error ? err.message : String(err),
      }),
    );
    await updateJobStatus(config.jobsTable, jobId, "failed", "録画ワーカーの起動に失敗しました", {
      errorCode: "launch_failed",
    });
    return error(
      502,
      "launch_failed",
      "録画ワーカーの起動に失敗しました。時間をおいて再試行してください",
    );
  }

  // 実際の "launching" への遷移は非同期に Launch タスクが行う。フロントは
  // ポーリングで状態を追従するため、ここでは queued のまま返してよい。
  const response: StartJobResponse = { jobId, status: "queued" };
  return json(200, response);
};
