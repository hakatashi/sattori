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
    await updateJobStatus(config.jobsTable, job.jobId, "failed");
    return error(502, "launch_failed", "録画ワーカーの起動に失敗しました。時間をおいて再試行してください");
  }

  const response: CreateJobResponse = { jobId: job.jobId, status: "launching" };
  return json(202, response);
};
