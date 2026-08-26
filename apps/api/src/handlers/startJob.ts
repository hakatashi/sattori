import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import type { StartJobResponse } from "@sattori/shared";
import { loadConfig, required } from "../config.js";
import { error, json } from "../http.js";
import { getJob, JobAlreadyStartedError, startPendingJob, updateJobStatus } from "../jobs.js";
import { INITIAL_ATTEMPT } from "../retryPolicy.js";
import { getSettings } from "../settings.js";
import { buildExecutionArn, getExecutionLiveness } from "../stepFunctions.js";
import type { LaunchTaskEvent } from "./sfn/launch.js";

const sfn = new SFNClient({});

/**
 * ジョブの`queued`への遷移が確定した後にStep Functionsの実行を開始する
 * （初回起動、および下記`重複起動の救済`からの再試行の両方から呼ぶ）。
 * 失敗時は原因をCloudWatch Logsへ残したうえでジョブを`failed`に確定し、例外を投げる
 * （呼び出し側は捕まえて502を返す）。
 */
async function startExecution(jobId: string, jobsTable: string): Promise<StartJobResponse> {
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
    await updateJobStatus(jobsTable, jobId, "failed", "録画ワーカーの起動に失敗しました", {
      errorCode: "launch_failed",
    });
    throw err;
  }

  // 実際の "launching" への遷移は非同期に Launch タスクが行う。フロントは
  // ポーリングで状態を追従するため、ここでは queued のまま返してよい。
  return { jobId, status: "queued" };
}

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
    // 起動済み（2回目以降のアクセス）。
    //
    // `queued`のみ、Step Functions実行の生死を確認する（Issue #132 経路(a)）。
    // `startPendingJob`が成功した直後、`StartExecutionCommand`が呼ばれる前に
    // Lambdaが死ぬと、ジョブは`queued`のまま実行が存在しない状態で永久に固まる
    // ——実行名にjobIdをそのまま使っているため、`absent`（未起動）と分かれば
    // `StartExecutionCommand`だけを冪等に張り直せる。`queued`以外
    // （`launching`以降）は、実行が既に一度は始まっている証拠なのでここでは扱わない
    // （実行だけが消えて非終端のまま固まるケースは`handlers/sweepStalledJobs.ts`が拾う）。
    if (job.status === "queued") {
      let liveness;
      try {
        liveness = await getExecutionLiveness(
          sfn,
          buildExecutionArn(required("STATE_MACHINE_ARN"), jobId),
        );
      } catch (err) {
        // 判定不能なら再起動せず現状のまま返す（二重起動の害の方が大きい）。
        console.error(
          JSON.stringify({
            event: "start_job_describe_execution_failed",
            jobId,
            message: err instanceof Error ? err.message : String(err),
          }),
        );
        liveness = "running" as const;
      }
      if (liveness === "absent") {
        try {
          const response = await startExecution(jobId, config.jobsTable);
          return json(200, response);
        } catch {
          return error(
            502,
            "launch_failed",
            "録画ワーカーの起動に失敗しました。時間をおいて再試行してください",
          );
        }
      }
    }
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
    const response = await startExecution(jobId, config.jobsTable);
    return json(200, response);
  } catch {
    return error(
      502,
      "launch_failed",
      "録画ワーカーの起動に失敗しました。時間をおいて再試行してください",
    );
  }
};
