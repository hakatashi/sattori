import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { ADMIN_ANALYTICS_DEFAULT_DAYS, ADMIN_ANALYTICS_MAX_DAYS } from "@sattori/shared";
import type { AdminAnalyticsSummaryResponse } from "@sattori/shared";
import { summarizeAnalytics } from "../../adminAnalytics.js";
import { loadConfig } from "../../config.js";
import { json } from "../../http.js";

/** 日数を範囲内へクランプする。不正値は既定値（`adminCosts.ts`の`normalizeBucketLimit`と同じ流儀）。 */
function normalizeDays(raw: string | undefined): number {
  const parsed = raw !== undefined ? Number(raw) : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return ADMIN_ANALYTICS_DEFAULT_DAYS;
  }
  return Math.min(Math.floor(parsed), ADMIN_ANALYTICS_MAX_DAYS);
}

/**
 * GET /admin/analytics?days=
 * `AnalyticsEventsTable`（Issue #142・#144）から、直近`days`日ぶんのユニーク訪問者数・
 * ページビュー数・パースエラー件数と属性別の内訳を集計して返す（管理画面。Issue #149）。
 * 認可はAPI Gateway側のLambda Authorizerが担う。
 *
 * ユニーク訪問者数は`visitorHash`（IPを日次saltでハッシュ化した値、
 * `docs/decisions/0026-hashed-visitor-id-daily-salt.md`）のユニーク件数で、
 * **日をまたいだ重複は排除できない**（`totals.uniqueVisitorDays`のJSDoc参照）。
 */
export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const config = loadConfig();
  const query = event.queryStringParameters ?? {};

  const days = normalizeDays(query.days);
  const result = await summarizeAnalytics(config.analyticsEventsTable, { days, now: new Date() });

  const response: AdminAnalyticsSummaryResponse = result;
  return json(200, response);
};
