import { randomUUID } from "node:crypto";
import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import {
  EMAIL_PATTERN,
  isSupportedGame,
  type GameId,
  type JobRecord,
  type RequestMagicLinkRequest,
  type RequestMagicLinkResponse,
} from "@sattori/shared";
import { loadConfig } from "../config.js";
import { error, json, parseBody } from "../http.js";
import { deleteJob, PENDING_JOB_TTL_MS, putJob } from "../jobs.js";
import { checkAndRecordRateLimit } from "../rateLimit.js";
import { sendMagicLinkEmail } from "../ses.js";

/**
 * POST /magic-links
 * マジックリンクメールの送信要求（ページAの「次のステップ」）。
 * この時点で status: "pending" の JobRecord を作成するが、Step Functionsは
 * まだ起動しない。払い出した jobId はレスポンスに含めず、メール本文のリンクとして
 * のみ通知する（jobId自体がメールを確認しないと分からない、録画起動の実質的な
 * 秘密として機能する。`POST /jobs/{jobId}/start` で実際に起動する。Issue #9）。
 */
export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const config = loadConfig();
  const body = parseBody<RequestMagicLinkRequest>(event);
  if (
    !body ||
    typeof body.replayKey !== "string" ||
    !body.options ||
    typeof body.email !== "string"
  ) {
    return error(400, "invalid_request", "replayKey と options と email は必須です");
  }
  if (!EMAIL_PATTERN.test(body.email)) {
    return error(400, "invalid_email", "メールアドレスの形式が正しくありません");
  }

  // ページAはリプレイ解析結果（ReplayInfo.game）を渡してくるが、念のため
  // 未指定なら th07 を既定とする。
  const game: GameId = body.game ?? "th07";
  if (!isSupportedGame(game)) {
    return error(422, "unsupported_game", "現在このタイトルの録画には対応していません");
  }

  const { allowed } = await checkAndRecordRateLimit(config.emailRateLimitTable, body.email);
  if (!allowed) {
    return error(
      429,
      "rate_limited",
      "送信回数の上限に達しました。時間をおいて再試行してください",
    );
  }

  const now = new Date();
  const jobId = randomUUID();
  const job: JobRecord = {
    jobId,
    game,
    replayKey: body.replayKey,
    status: "pending",
    options: { watermark: body.options.watermark !== false },
    outputPath: null,
    outputPath720p: null,
    error: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    email: body.email,
    instanceId: null,
    estimatedDurationSeconds: body.estimatedDurationSeconds ?? null,
    progress: null,
    previewImagePath: null,
    pendingExpiresAt: new Date(now.getTime() + PENDING_JOB_TTL_MS).toISOString(),
  };

  try {
    await putJob(config.jobsTable, job);
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "put_job_failed",
        jobId,
        name: err instanceof Error ? err.name : undefined,
        message: err instanceof Error ? err.message : String(err),
      }),
    );
    return error(500, "internal_error", "処理に失敗しました。時間をおいて再試行してください");
  }

  try {
    await sendMagicLinkEmail({
      from: config.sesFromAddress,
      to: job.email as string,
      webBaseUrl: config.webBaseUrl,
      jobId: job.jobId,
    });
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "send_magic_link_email_failed",
        jobId,
        name: err instanceof Error ? err.name : undefined,
        message: err instanceof Error ? err.message : String(err),
      }),
    );
    // メールが届かない以上このジョブには誰もアクセスできないため、pendingのまま
    // 残さず削除する（ユーザーは再度「次のステップ」からやり直すことになる）。
    await deleteJob(config.jobsTable, jobId).catch((cleanupErr) => {
      console.error(
        JSON.stringify({
          event: "delete_job_after_email_failure_failed",
          jobId,
          name: cleanupErr instanceof Error ? cleanupErr.name : undefined,
          message: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
        }),
      );
    });
    return error(
      502,
      "email_send_failed",
      "メールの送信に失敗しました。時間をおいて再試行してください",
    );
  }

  const response: RequestMagicLinkResponse = {};
  return json(202, response);
};
