import { randomBytes, randomUUID } from "node:crypto";
import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import {
  isSupportedGame,
  type GameId,
  type RequestMagicLinkRequest,
  type RequestMagicLinkResponse,
} from "@sattori/shared";
import { loadConfig } from "../config.js";
import { error, json, parseBody } from "../http.js";
import { putMagicLink } from "../magicLinks.js";
import { checkAndRecordRateLimit } from "../rateLimit.js";
import { sendMagicLinkEmail } from "../ses.js";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * POST /magic-links
 * マジックリンクメールの送信要求（ページAの「次のステップ」）。
 * この時点ではジョブ（DynamoDBレコード）は作らず、Step Functionsも起動しない。
 * `POST /jobs/{jobId}/confirm` でトークンが確認されて初めてジョブが実体化する（Issue #9）。
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

  // フェーズ1はリプレイ解析未実装のため、game 未指定なら th07 を既定とする。
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

  const magicLink = await putMagicLink(config.magicLinksTable, {
    token: generateToken(),
    jobId: randomUUID(),
    email: body.email,
    replayKey: body.replayKey,
    game,
    options: { watermark: body.options.watermark !== false },
    estimatedDurationSeconds: body.estimatedDurationSeconds ?? null,
  });

  await sendMagicLinkEmail({
    from: config.sesFromAddress,
    to: magicLink.email,
    webBaseUrl: config.webBaseUrl,
    jobId: magicLink.jobId,
    token: magicLink.token,
  });

  const response: RequestMagicLinkResponse = {};
  return json(202, response);
};
