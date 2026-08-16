import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import {
  classifyDeviceCategory,
  extractClientIp,
  extractReferrerHost,
  hashVisitorId,
  primaryLanguageTag,
  recordAnalyticsEvent,
} from "./analytics.js";

describe("classifyDeviceCategory", () => {
  it("768未満はmobile", () => {
    expect(classifyDeviceCategory(375)).toBe("mobile");
    expect(classifyDeviceCategory(767)).toBe("mobile");
  });

  it("768以上1024未満はtablet", () => {
    expect(classifyDeviceCategory(768)).toBe("tablet");
    expect(classifyDeviceCategory(1023)).toBe("tablet");
  });

  it("1024以上はdesktop", () => {
    expect(classifyDeviceCategory(1024)).toBe("desktop");
    expect(classifyDeviceCategory(2560)).toBe("desktop");
  });
});

describe("extractReferrerHost", () => {
  it("nullや空文字はnullを返す", () => {
    expect(extractReferrerHost(null)).toBeNull();
    expect(extractReferrerHost("")).toBeNull();
  });

  it("ホスト名のみを取り出し、パス・クエリは捨てる", () => {
    expect(extractReferrerHost("https://www.google.com/search?q=touhou+sattori")).toBe(
      "www.google.com",
    );
  });

  it("不正なURLはnullへ縮退する", () => {
    expect(extractReferrerHost("not-a-url")).toBeNull();
  });
});

describe("primaryLanguageTag", () => {
  it("nullはnullを返す", () => {
    expect(primaryLanguageTag(null)).toBeNull();
  });

  it("最優先タグの主言語部分のみを返す", () => {
    expect(primaryLanguageTag("ja-JP,en;q=0.9")).toBe("ja");
    expect(primaryLanguageTag("en-US,ja;q=0.8")).toBe("en");
  });
});

describe("hashVisitorId", () => {
  it("同じIP・saltなら同じハッシュを返す", () => {
    expect(hashVisitorId("203.0.113.1", "salt-a")).toBe(hashVisitorId("203.0.113.1", "salt-a"));
  });

  it("saltが違えば同じIPでも別のハッシュになる（日をまたいだ突き合わせ防止）", () => {
    expect(hashVisitorId("203.0.113.1", "salt-a")).not.toBe(
      hashVisitorId("203.0.113.1", "salt-b"),
    );
  });

  it("生IPをハッシュに含まない", () => {
    expect(hashVisitorId("203.0.113.1", "salt-a")).not.toContain("203.0.113.1");
  });
});

describe("extractClientIp", () => {
  it("X-Forwarded-Forの先頭値を優先する（CloudFront経由、Issue #144）", () => {
    expect(extractClientIp({ "x-forwarded-for": "203.0.113.1, 10.0.0.1" }, "10.0.0.1")).toBe(
      "203.0.113.1",
    );
  });

  it("X-Forwarded-Forが無ければsourceIpにフォールバックする（直接叩かれた場合）", () => {
    expect(extractClientIp({}, "203.0.113.9")).toBe("203.0.113.9");
  });

  it("どちらも無ければnull", () => {
    expect(extractClientIp({}, null)).toBeNull();
  });
});

describe("recordAnalyticsEvent", () => {
  const ddbMock = mockClient(DynamoDBDocumentClient);

  beforeEach(() => {
    ddbMock.reset();
  });

  it("pageviewイベントを、生IP・生UAを含まない形でPutCommandに渡す", async () => {
    ddbMock.on(PutCommand).resolvesOnce({});

    await recordAnalyticsEvent(
      "analytics-table",
      "settings-table",
      {
        type: "pageview",
        path: "/jobs/:id",
        referrer: "https://x.com/some/status/123",
        utmSource: "twitter",
        utmMedium: null,
        utmCampaign: null,
        viewportWidth: 390,
      },
      {
        country: "JP",
        acceptLanguage: "ja-JP,en;q=0.9",
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
        sourceIp: null,
      },
    );

    const calls = ddbMock.commandCalls(PutCommand);
    expect(calls).toHaveLength(1);
    const item = calls[0]?.args[0].input.Item as Record<string, unknown>;
    expect(item).toMatchObject({
      type: "pageview",
      path: "/jobs/:id",
      referrerHost: "x.com",
      utmSource: "twitter",
      deviceCategory: "mobile",
      country: "JP",
      language: "ja",
      browserFamily: "safari",
      osFamily: "ios",
      visitorHash: null,
    });
    expect(JSON.stringify(item)).not.toContain("iPhone");
    expect(calls[0]?.args[0].input.TableName).toBe("analytics-table");
  });

  it("parse_errorイベントを記録する", async () => {
    ddbMock.on(PutCommand).resolvesOnce({});

    await recordAnalyticsEvent(
      "analytics-table",
      "settings-table",
      { type: "parse_error", errorCode: "unsupported_game", game: "th09" },
      { country: null, acceptLanguage: null, userAgent: null, sourceIp: null },
    );

    const calls = ddbMock.commandCalls(PutCommand);
    const item = calls[0]?.args[0].input.Item as Record<string, unknown>;
    expect(item).toMatchObject({
      type: "parse_error",
      errorCode: "unsupported_game",
      game: "th09",
      country: null,
      language: null,
      browserFamily: null,
      osFamily: null,
      visitorHash: null,
    });
  });

  it("sourceIpがあれば日次saltを取得・生成してvisitorHashを記録する（Issue #144）", async () => {
    ddbMock.on(GetCommand).resolvesOnce({}); // その日のsaltはまだ無い
    ddbMock.on(PutCommand).resolves({});

    await recordAnalyticsEvent(
      "analytics-table",
      "settings-table",
      {
        type: "pageview",
        path: "/",
        referrer: null,
        utmSource: null,
        utmMedium: null,
        utmCampaign: null,
        viewportWidth: 1280,
      },
      { country: null, acceptLanguage: null, userAgent: null, sourceIp: "203.0.113.1" },
    );

    const putCalls = ddbMock.commandCalls(PutCommand);
    const saltPut = putCalls.find((c) => c.args[0].input.TableName === "settings-table");
    const eventPut = putCalls.find((c) => c.args[0].input.TableName === "analytics-table");
    const salt = (saltPut?.args[0].input.Item as Record<string, unknown> | undefined)?.salt;
    expect(typeof salt).toBe("string");

    const expectedHash = createHash("sha256").update(`${salt}:203.0.113.1`).digest("hex");
    expect((eventPut?.args[0].input.Item as Record<string, unknown>).visitorHash).toBe(
      expectedHash,
    );
  });
});
