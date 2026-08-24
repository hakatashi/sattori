import { beforeEach, describe, expect, it } from "vitest";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { summarizeAnalytics } from "./adminAnalytics.js";

const ddbMock = mockClient(DynamoDBDocumentClient);

const NOW = new Date("2026-08-25T12:00:00.000Z");

function itemsForDate(eventDate: string, items: Record<string, unknown>[]) {
  ddbMock
    .on(QueryCommand, { ExpressionAttributeValues: { ":eventDate": eventDate } })
    .resolves({ Items: items });
}

describe("summarizeAnalytics", () => {
  beforeEach(() => {
    ddbMock.reset();
    ddbMock.on(QueryCommand).resolves({ Items: [] });
  });

  it("日付範囲は`now`を含む直近`days`日ぶん(古い順)", async () => {
    const result = await summarizeAnalytics("analytics", { days: 3, now: NOW });
    expect(result.daily.map((bucket) => bucket.date)).toEqual([
      "2026-08-23",
      "2026-08-24",
      "2026-08-25",
    ]);
    expect(result.from).toBe("2026-08-23");
    expect(result.to).toBe("2026-08-25");
  });

  it("visitorHashのユニーク件数は日毎に数え、日をまたいでは合算しない", async () => {
    itemsForDate("2026-08-24", [
      { type: "pageview", visitorHash: "a", country: "JP", language: "ja", browserFamily: "chrome", osFamily: "windows", path: "/", referrerHost: null, deviceCategory: "desktop" },
      { type: "pageview", visitorHash: "a", country: "JP", language: "ja", browserFamily: "chrome", osFamily: "windows", path: "/", referrerHost: null, deviceCategory: "desktop" },
      { type: "pageview", visitorHash: "b", country: "JP", language: "ja", browserFamily: "chrome", osFamily: "windows", path: "/", referrerHost: null, deviceCategory: "desktop" },
    ]);
    // 同じ実訪問者でもsaltが日次ローテーションのため別ハッシュになる(=別カウント)。
    itemsForDate("2026-08-25", [
      { type: "pageview", visitorHash: "c", country: "JP", language: "ja", browserFamily: "chrome", osFamily: "windows", path: "/", referrerHost: null, deviceCategory: "desktop" },
    ]);

    const result = await summarizeAnalytics("analytics", { days: 2, now: NOW });
    const day24 = result.daily.find((bucket) => bucket.date === "2026-08-24");
    const day25 = result.daily.find((bucket) => bucket.date === "2026-08-25");
    expect(day24?.uniqueVisitors).toBe(2);
    expect(day24?.pageviews).toBe(3);
    expect(day25?.uniqueVisitors).toBe(1);
    expect(result.totals.uniqueVisitorDays).toBe(3);
    expect(result.totals.pageviews).toBe(4);
  });

  it("pageviewとparse_errorを別々に数え、内訳を種別ごとに集計する", async () => {
    itemsForDate("2026-08-25", [
      { type: "pageview", visitorHash: "a", country: "JP", language: "ja", browserFamily: "chrome", osFamily: "windows", path: "/upload", referrerHost: "google.com", deviceCategory: "mobile", utmSource: "twitter" },
      { type: "parse_error", visitorHash: "a", country: "JP", language: "ja", browserFamily: "chrome", osFamily: "windows", errorCode: "unsupported_game", game: "th19" },
      { type: "parse_error", visitorHash: null, country: null, language: null, browserFamily: null, osFamily: null, errorCode: "corrupt_file" },
    ]);

    const result = await summarizeAnalytics("analytics", { days: 1, now: NOW });
    const day = result.daily[0];
    expect(day?.pageviews).toBe(1);
    expect(day?.parseErrors).toBe(2);
    expect(result.breakdowns.paths).toEqual([{ key: "/upload", count: 1 }]);
    expect(result.breakdowns.referrers).toEqual([{ key: "google.com", count: 1 }]);
    expect(result.breakdowns.utmSources).toEqual([{ key: "twitter", count: 1 }]);
    expect(result.breakdowns.parseErrorCodes).toEqual(
      expect.arrayContaining([
        { key: "unsupported_game", count: 1 },
        { key: "corrupt_file", count: 1 },
      ]),
    );
    expect(result.breakdowns.parseErrorGames).toEqual([{ key: "th19", count: 1 }]);
    // 国・言語・ブラウザ/OSはpageview/parse_error両方から積み上げる。nullは(unknown)。
    expect(result.breakdowns.countries).toEqual(
      expect.arrayContaining([
        { key: "JP", count: 2 },
        { key: "(unknown)", count: 1 },
      ]),
    );
  });

  it("参照元が無いpageviewは(direct)として集計する", async () => {
    itemsForDate("2026-08-25", [
      { type: "pageview", visitorHash: "a", country: "JP", language: "ja", browserFamily: "chrome", osFamily: "windows", path: "/", referrerHost: null, deviceCategory: "desktop" },
    ]);

    const result = await summarizeAnalytics("analytics", { days: 1, now: NOW });
    expect(result.breakdowns.referrers).toEqual([{ key: "(direct)", count: 1 }]);
  });

  it("内訳は上位10件・同数はキー昇順に切り詰められる", async () => {
    const items = Array.from({ length: 15 }, (_, index) => ({
      type: "pageview",
      visitorHash: `v${index}`,
      country: "JP",
      language: "ja",
      browserFamily: "chrome",
      osFamily: "windows",
      path: `/page-${String(index).padStart(2, "0")}`,
      referrerHost: null,
      deviceCategory: "desktop",
    }));
    itemsForDate("2026-08-25", items);

    const result = await summarizeAnalytics("analytics", { days: 1, now: NOW });
    expect(result.breakdowns.paths).toHaveLength(10);
    // 全件同数(1)なのでキー昇順で先頭10件になる。
    expect(result.breakdowns.paths[0]).toEqual({ key: "/page-00", count: 1 });
    expect(result.breakdowns.paths.at(-1)).toEqual({ key: "/page-09", count: 1 });
  });
});
