import { randomUUID } from "node:crypto";
import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import {
  isSupportedGame,
  type CreateJobRequest,
  type CreateJobResponse,
  type GameId,
  type JobRecord,
} from "@sattori/shared";
import { loadConfig, required } from "../config.js";
import { error, json, parseBody } from "../http.js";
import { putJob, updateJobStatus } from "../jobs.js";
import type { LaunchTaskEvent } from "./sfn/launch.js";

const sfn = new SFNClient({});

/**
 * POST /jobs
 * 録画ジョブを作成し、Step Functions の実行を開始する。実際の EC2 起動は
 * ステートマシンの `Launch` タスクが非同期に行う（Spot中断時の自動リトライ・
 * 60分タイムアウトのオーケストレーションは Issue #11 参照）。
 * フェーズ1ではメール認証を挟まず、この呼び出しで即座に実行を開始する
 * （認証・マジックリンクはフェーズ2で前段に追加する）。
 */
export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const config = loadConfig();
  const body = parseBody<CreateJobRequest>(event);
  if (!body || typeof body.replayKey !== "string" || !body.options) {
    return error(400, "invalid_request", "replayKey と options は必須です");
  }

  // フェーズ1はリプレイ解析未実装のため、game 未指定なら th07 を既定とする。
  const game: GameId = body.game ?? "th07";
  if (!isSupportedGame(game)) {
    return error(422, "unsupported_game", "現在このタイトルの録画には対応していません");
  }

  const now = new Date().toISOString();
  const job: JobRecord = {
    jobId: randomUUID(),
    game,
    replayKey: body.replayKey,
    status: "queued",
    options: { watermark: body.options.watermark !== false },
    outputPath: null,
    outputPath720p: null,
    error: null,
    createdAt: now,
    updatedAt: now,
    email: null,
    instanceId: null,
    estimatedDurationSeconds: body.estimatedDurationSeconds ?? null,
    progress: null,
    previewImagePath: null,
  };

  await putJob(config.jobsTable, job);

  try {
    const input: Pick<LaunchTaskEvent, "jobId" | "attempt"> = { jobId: job.jobId, attempt: 1 };
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
    return error(502, "launch_failed", "録画ワーカーの起動に失敗しました。時間をおいて再試行してください");
  }

  // 実際の "launching" への遷移は非同期に Launch タスクが行う。フロントは
  // ポーリングで状態を追従するため、ここでは queued のまま返してよい。
  const response: CreateJobResponse = { jobId: job.jobId, status: job.status };
  return json(202, response);
};
