import { randomUUID } from "node:crypto";
import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import {
  isSupportedGame,
  type CreateJobRequest,
  type CreateJobResponse,
  type GameId,
  type JobRecord,
} from "@sattori/shared";
import { loadConfig } from "../config.js";
import { launchRecordingInstance } from "../ec2.js";
import { error, json, parseBody } from "../http.js";
import { putJob, updateJobStatus } from "../jobs.js";

/**
 * POST /jobs
 * 録画ジョブを作成し、EC2 Spot ワーカーを起動する。
 * フェーズ1ではメール認証を挟まず、この呼び出しで即座に起動する
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
    error: null,
    createdAt: now,
    updatedAt: now,
    email: null,
  };

  await putJob(config.jobsTable, job);

  try {
    await launchRecordingInstance(config, job);
    await updateJobStatus(config.jobsTable, job.jobId, "launching");
  } catch (err) {
    // RunInstances 失敗の原因（Spotキャパシティ不足/IAM/AMI等）を切り分けられるよう、
    // 例外の詳細を CloudWatch Logs に残す（DynamoDB の error は簡潔な文言のみ保持）。
    console.error(
      JSON.stringify({
        event: "launch_failed",
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

  const response: CreateJobResponse = { jobId: job.jobId, status: "launching" };
  return json(202, response);
};
