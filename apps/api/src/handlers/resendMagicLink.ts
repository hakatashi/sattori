import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import type { ResendMagicLinkRequest, ResendMagicLinkResponse } from "@sattori/shared";
import { loadConfig } from "../config.js";
import { error, json, parseBody } from "../http.js";
import { extendMagicLinkExpiry, getMagicLink } from "../magicLinks.js";
import { checkAndRecordRateLimit } from "../rateLimit.js";
import { sendMagicLinkEmail } from "../ses.js";

/**
 * POST /jobs/{jobId}/resend
 * マジックリンクの再送要求（期限切れ・メール未着時の再送導線）。
 * 未使用のトークンのみ再送可能。同一トークン・同一リンクURLのまま有効期限を
 * 延長する（新しいトークンは発行しない）。送信自体はレート制限の対象（Issue #9）。
 */
export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const config = loadConfig();
  const jobId = event.pathParameters?.jobId;
  if (!jobId) {
    return error(400, "invalid_request", "jobId が指定されていません");
  }
  const body = parseBody<ResendMagicLinkRequest>(event);
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

  const { allowed } = await checkAndRecordRateLimit(config.emailRateLimitTable, magicLink.email);
  if (!allowed) {
    return error(
      429,
      "rate_limited",
      "送信回数の上限に達しました。時間をおいて再試行してください",
    );
  }

  await extendMagicLinkExpiry(config.magicLinksTable, magicLink.token);
  await sendMagicLinkEmail({
    from: config.sesFromAddress,
    to: magicLink.email,
    webBaseUrl: config.webBaseUrl,
    jobId: magicLink.jobId,
    token: magicLink.token,
  });

  const response: ResendMagicLinkResponse = {};
  return json(202, response);
};
