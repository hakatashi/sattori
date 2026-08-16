import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { AnalyticsEventInput } from "@sattori/shared";
import { classifyUserAgent } from "./userAgent.js";

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/**
 * 生イベントの保持期間（日）。集計用の一次データであり、無期限に貯める設計には
 * していない（Issue #142。`docs/decisions/0024-cookieless-analytics-beacon.md`）。
 */
export const ANALYTICS_EVENT_TTL_DAYS = 180;

export type DeviceCategory = "mobile" | "tablet" | "desktop";

const MOBILE_MAX_WIDTH = 768;
const TABLET_MAX_WIDTH = 1024;

export function classifyDeviceCategory(viewportWidth: number): DeviceCategory {
  if (viewportWidth < MOBILE_MAX_WIDTH) return "mobile";
  if (viewportWidth < TABLET_MAX_WIDTH) return "tablet";
  return "desktop";
}

/**
 * `document.referrer`からホスト名だけを取り出す。フルパス・クエリ文字列は
 * 検索キーワード等のPIIになりうるため保持しない（同一オリジン内遷移や
 * 取得できない値はnullとして扱う）。
 */
export function extractReferrerHost(referrer: string | null): string | null {
  if (!referrer) return null;
  try {
    return new URL(referrer).hostname || null;
  } catch {
    return null;
  }
}

/** `Accept-Language`の最優先タグの主言語部分のみを取り出す（例: "ja-JP,en;q=0.9" → "ja"）。 */
export function primaryLanguageTag(acceptLanguage: string | null): string | null {
  if (!acceptLanguage) return null;
  const first = acceptLanguage.split(",")[0]?.trim().split(";")[0]?.trim();
  if (!first) return null;
  return first.split("-")[0]?.toLowerCase() || null;
}

/** ヘッダーから得られる、イベントに共通する文脈情報。 */
export interface AnalyticsEventContext {
  /** `CloudFront-Viewer-Country`ヘッダー。CloudFrontを経由しないリクエストではnull。 */
  country: string | null;
  acceptLanguage: string | null;
  userAgent: string | null;
}

/**
 * `AnalyticsEventInput`と`AnalyticsEventContext`から、生IP・生User-Agentを含まない
 * DynamoDBアイテムを組み立てて`AnalyticsEventsTable`へ書き込む。
 */
export async function recordAnalyticsEvent(
  table: string,
  input: AnalyticsEventInput,
  context: AnalyticsEventContext,
): Promise<void> {
  const now = new Date();
  const { browserFamily, osFamily } = classifyUserAgent(context.userAgent);

  const common = {
    eventDate: now.toISOString().slice(0, 10),
    eventId: randomUUID(),
    createdAt: now.toISOString(),
    ttl: Math.floor(now.getTime() / 1000) + ANALYTICS_EVENT_TTL_DAYS * 24 * 60 * 60,
    country: context.country,
    language: primaryLanguageTag(context.acceptLanguage),
    browserFamily,
    osFamily,
  };

  const item =
    input.type === "pageview"
      ? {
          ...common,
          type: "pageview",
          path: input.path,
          referrerHost: extractReferrerHost(input.referrer),
          utmSource: input.utmSource,
          utmMedium: input.utmMedium,
          utmCampaign: input.utmCampaign,
          deviceCategory: classifyDeviceCategory(input.viewportWidth),
        }
      : {
          ...common,
          type: "parse_error",
          errorCode: input.errorCode,
          game: input.game,
        };

  await client.send(new PutCommand({ TableName: table, Item: item }));
}
