import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import type { AnalyticsEventInput, RecordAnalyticsEventResponse } from "@sattori/shared";
import { recordAnalyticsEvent } from "../analytics.js";
import { loadAnalyticsConfig } from "../config.js";
import { error, json, parseBody } from "../http.js";

/** ブラウザの実際の値と乖離した異常値（改ざん・バグ由来）を弾くための緩い上限。 */
const MAX_VIEWPORT_WIDTH = 20000;

function isValidInput(body: unknown): body is AnalyticsEventInput {
  if (typeof body !== "object" || body === null) {
    return false;
  }
  const b = body as Record<string, unknown>;
  if (b.type === "pageview") {
    return (
      typeof b.path === "string" &&
      typeof b.viewportWidth === "number" &&
      b.viewportWidth > 0 &&
      b.viewportWidth < MAX_VIEWPORT_WIDTH
    );
  }
  if (b.type === "parse_error") {
    return typeof b.errorCode === "string";
  }
  return false;
}

/**
 * POST /beacon
 *
 * Cookie・訪問者IDを一切使わないサーバーサイド計測（Issue #142）。WebCdn
 * （CloudFront）の`/beacon`ビヘイビアからのみ`CloudFront-Viewer-Country`ヘッダーが
 * 付与される前提だが、直接叩かれてヘッダーが無くても`country: null`で記録するだけで
 * 失敗はしない。設計の背景は
 * `docs/decisions/0024-cookieless-analytics-beacon.md`。
 *
 * 計測のためだけの経路であり、失敗してもユーザー体験に影響させない
 * （呼び出し側は`navigator.sendBeacon`でレスポンスを見ない）。
 */
export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const body = parseBody<unknown>(event);
  if (!isValidInput(body)) {
    return error(400, "invalid_analytics_event", "不正なイベントです");
  }

  const { analyticsEventsTable } = loadAnalyticsConfig();
  const headers = event.headers ?? {};

  try {
    await recordAnalyticsEvent(analyticsEventsTable, body, {
      country: headers["cloudfront-viewer-country"] ?? null,
      acceptLanguage: headers["accept-language"] ?? null,
      userAgent: headers["user-agent"] ?? null,
    });
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "analytics_event_write_failed",
        message: err instanceof Error ? err.message : String(err),
      }),
    );
  }

  return json(202, {} satisfies RecordAnalyticsEventResponse);
};
