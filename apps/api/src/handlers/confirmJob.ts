import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import type { ConfirmJobRequest, ConfirmJobResponse, JobRecord } from "@sattori/shared";
import { loadConfig, required } from "../config.js";
import { error, json, parseBody } from "../http.js";
import { putJob, updateJobStatus } from "../jobs.js";
import { getMagicLink, markMagicLinkUsed, MagicLinkAlreadyUsedError } from "../magicLinks.js";
import { INITIAL_ATTEMPT } from "../retryPolicy.js";
import type { LaunchTaskEvent } from "./sfn/launch.js";

const sfn = new SFNClient({});

/**
 * POST /jobs/{jobId}/confirm
 * マジックリンクの確認・ジョブ起動要求（ページBの初回表示から呼ばれる）。
 * トークンが有効（未使用・期限内）であれば `POST /magic-links` 時点の内容から
 * ジョブを作成し、Step Functions の実行を開始する
 * （実際の EC2 起動はステートマシンの `Launch` タスクが非同期に行う。Issue #11）。
 * フェーズ1で `POST /jobs` が担っていた「即座に起動」は、マジックリンク確認を
 * 挟むこのフローに置き換わった（Issue #9）。
 */
export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const config = loadConfig();
  const jobId = event.pathParameters?.jobId;
  if (!jobId) {
    return error(400, "invalid_request", "jobId が指定されていません");
  }
  const body = parseBody<ConfirmJobRequest>(event);
  if (!body || typeof body.token !== "string") {
    return error(400, "invalid_request", "token は必須です");
  }

  const magicLink = await getMagicLink(config.magicLinksTable, body.token);
  if (!magicLink || magicLink.jobId !== jobId) {
    return error(404, "invalid_token", "リンクが無効です");
  }
  if (magicLink.usedAt !== null) {
    return error(409, "token_already_used", "このリンクは既に使用されています");
  }
  if (new Date(magicLink.expiresAt).getTime() < Date.now()) {
    return error(410, "token_expired", "リンクの有効期限が切れています");
  }

  try {
    await markMagicLinkUsed(config.magicLinksTable, magicLink.token);
  } catch (err) {
    if (err instanceof MagicLinkAlreadyUsedError) {
      return error(409, "token_already_used", "このリンクは既に使用されています");
    }
    throw err;
  }

  const now = new Date().toISOString();
  const job: JobRecord = {
    jobId: magicLink.jobId,
    game: magicLink.game,
    replayKey: magicLink.replayKey,
    status: "queued",
    options: magicLink.options,
    outputPath: null,
    outputPath720p: null,
    error: null,
    createdAt: now,
    updatedAt: now,
    email: magicLink.email,
    instanceId: null,
    estimatedDurationSeconds: magicLink.estimatedDurationSeconds,
    progress: null,
    previewImagePath: null,
  };

  await putJob(config.jobsTable, job);

  try {
    const input: Pick<LaunchTaskEvent, "jobId" | "attempt"> = {
      jobId: job.jobId,
      attempt: INITIAL_ATTEMPT,
    };
    await sfn.send(
      new StartExecutionCommand({
        stateMachineArn: required("STATE_MACHINE_ARN"),
        name: job.jobId,
        input: JSON.stringify(input),
      }),
    );
  } catch (err) {
    // StartExecution 失敗の原因を切り分けられるよう、例外の詳細を CloudWatch Logs
    // に残す（DynamoDB の error は簡潔な文言のみ保持）。
    console.error(
      JSON.stringify({
        event: "start_execution_failed",
        jobId: job.jobId,
        name: err instanceof Error ? err.name : undefined,
        message: err instanceof Error ? err.message : String(err),
      }),
    );
    await updateJobStatus(
      config.jobsTable,
      job.jobId,
      "failed",
      "録画ワーカーの起動に失敗しました",
    );
    return error(
      502,
      "launch_failed",
      "録画ワーカーの起動に失敗しました。時間をおいて再試行してください",
    );
  }

  // 実際の "launching" への遷移は非同期に Launch タスクが行う。フロントは
  // ポーリングで状態を追従するため、ここでは queued のまま返してよい。
  const response: ConfirmJobResponse = { jobId: job.jobId, status: job.status };
  return json(202, response);
};
