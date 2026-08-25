import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import {
  ADMIN_ANALYTICS_BREAKDOWN_LIMIT,
  ADMIN_ANALYTICS_DIRECT_LABEL,
  ADMIN_ANALYTICS_UNKNOWN_LABEL,
} from "@sattori/shared";
import type { AdminAnalyticsBreakdownItem, AdminAnalyticsSummaryResponse } from "@sattori/shared";

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/**
 * 管理画面の訪問者アナリティクス集計（Issue #149）。`AnalyticsEventsTable`は
 * PK=eventDate/SK=eventIdなので、`adminCosts.ts`（`JobsTable`の全件Scan）とは違い
 * 「集計対象の日付ぶんだけQueryを発行し、アプリ側で集計する」方式にできる
 * （Query自体はパーティション単位で絞り込めるため、Scanより効率が良い）。
 * それでも`type`（pageview/parse_error）別・属性別の内訳はDynamoDB側で
 * 集計できないため、取得したイベントをアプリ側でMapへ積み上げる。
 */

/** `QueryCommand`で取得するフィールドだけに絞る（通信量・メモリ削減）。 */
const PROJECTION_EXPRESSION =
  "#type, visitorHash, #path, referrerHost, utmSource, country, #language, deviceCategory, browserFamily, osFamily, errorCode, game";
// type/path/languageはDynamoDBの予約語（"status"と同じ扱い、`adminCosts.ts`参照）。
const EXPRESSION_ATTRIBUTE_NAMES = { "#type": "type", "#path": "path", "#language": "language" };

interface AnalyticsEventItem {
  type: "pageview" | "parse_error";
  visitorHash: string | null;
  path?: string;
  referrerHost?: string | null;
  utmSource?: string | null;
  country: string | null;
  language: string | null;
  deviceCategory?: string;
  browserFamily: string | null;
  osFamily: string | null;
  errorCode?: string;
  game?: string | null;
}

export interface AnalyticsSummaryParams {
  /** 集計する日数（`from`〜`to`の両端を含む）。 */
  days: number;
  /** 「今日」の基準時刻（テストで固定するため注入する）。集計対象は`now`を含む直近`days`日間。 */
  now: Date;
}

/** `now`を含む直近`days`日ぶんのUTC日付（`YYYY-MM-DD`）を古い順で返す。 */
function lastNDates(now: Date, days: number): string[] {
  const dates: string[] = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(now.getTime() - offset * 24 * 60 * 60 * 1000);
    dates.push(date.toISOString().slice(0, 10));
  }
  return dates;
}

/** 1日ぶん（1パーティション）のイベントをページングを追い切って取得する。 */
async function queryEventsForDate(table: string, eventDate: string): Promise<AnalyticsEventItem[]> {
  const items: AnalyticsEventItem[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await client.send(
      new QueryCommand({
        TableName: table,
        KeyConditionExpression: "eventDate = :eventDate",
        ExpressionAttributeValues: { ":eventDate": eventDate },
        ProjectionExpression: PROJECTION_EXPRESSION,
        ExpressionAttributeNames: EXPRESSION_ATTRIBUTE_NAMES,
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }),
    );
    items.push(...((result.Items as AnalyticsEventItem[] | undefined) ?? []));
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey !== undefined);
  return items;
}

function bump(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

/** 件数の多い順（同数はキーの昇順）で上位`ADMIN_ANALYTICS_BREAKDOWN_LIMIT`件を返す。 */
function topEntries(counts: Map<string, number>): AdminAnalyticsBreakdownItem[] {
  return [...counts.entries()]
    .sort(([keyA, countA], [keyB, countB]) => countB - countA || (keyA < keyB ? -1 : keyA > keyB ? 1 : 0))
    .slice(0, ADMIN_ANALYTICS_BREAKDOWN_LIMIT)
    .map(([key, count]) => ({ key, count }));
}

export async function summarizeAnalytics(
  table: string,
  params: AnalyticsSummaryParams,
): Promise<AdminAnalyticsSummaryResponse> {
  const dates = lastNDates(params.now, params.days);
  // 日付ごとに独立したパーティションQueryなので、直列で待たず並行に発行する。
  const eventsByDate = await Promise.all(dates.map((date) => queryEventsForDate(table, date)));

  const paths = new Map<string, number>();
  const referrers = new Map<string, number>();
  const countries = new Map<string, number>();
  const languages = new Map<string, number>();
  const deviceCategories = new Map<string, number>();
  const browserFamilies = new Map<string, number>();
  const osFamilies = new Map<string, number>();
  const utmSources = new Map<string, number>();
  const parseErrorCodes = new Map<string, number>();
  const parseErrorGames = new Map<string, number>();

  const daily = dates.map((date, index) => {
    const events = eventsByDate[index] ?? [];
    const visitorHashes = new Set<string>();
    let pageviews = 0;
    let parseErrors = 0;

    for (const item of events) {
      if (item.visitorHash) {
        visitorHashes.add(item.visitorHash);
      }
      bump(countries, item.country ?? ADMIN_ANALYTICS_UNKNOWN_LABEL);
      bump(languages, item.language ?? ADMIN_ANALYTICS_UNKNOWN_LABEL);
      bump(browserFamilies, item.browserFamily ?? ADMIN_ANALYTICS_UNKNOWN_LABEL);
      bump(osFamilies, item.osFamily ?? ADMIN_ANALYTICS_UNKNOWN_LABEL);

      if (item.type === "pageview") {
        pageviews += 1;
        bump(paths, item.path ?? ADMIN_ANALYTICS_UNKNOWN_LABEL);
        bump(referrers, item.referrerHost ?? ADMIN_ANALYTICS_DIRECT_LABEL);
        bump(deviceCategories, item.deviceCategory ?? ADMIN_ANALYTICS_UNKNOWN_LABEL);
        if (item.utmSource) {
          bump(utmSources, item.utmSource);
        }
      } else {
        parseErrors += 1;
        bump(parseErrorCodes, item.errorCode ?? ADMIN_ANALYTICS_UNKNOWN_LABEL);
        if (item.game) {
          bump(parseErrorGames, item.game);
        }
      }
    }

    return { date, pageviews, uniqueVisitors: visitorHashes.size, parseErrors };
  });

  const totals = daily.reduce(
    (sum, bucket) => ({
      pageviews: sum.pageviews + bucket.pageviews,
      uniqueVisitorDays: sum.uniqueVisitorDays + bucket.uniqueVisitors,
      parseErrors: sum.parseErrors + bucket.parseErrors,
    }),
    { pageviews: 0, uniqueVisitorDays: 0, parseErrors: 0 },
  );

  return {
    days: params.days,
    from: dates[0] ?? "",
    to: dates.at(-1) ?? "",
    daily,
    totals,
    breakdowns: {
      paths: topEntries(paths),
      referrers: topEntries(referrers),
      countries: topEntries(countries),
      languages: topEntries(languages),
      deviceCategories: topEntries(deviceCategories),
      browserFamilies: topEntries(browserFamilies),
      osFamilies: topEntries(osFamilies),
      utmSources: topEntries(utmSources),
      parseErrorCodes: topEntries(parseErrorCodes),
      parseErrorGames: topEntries(parseErrorGames),
    },
  };
}
