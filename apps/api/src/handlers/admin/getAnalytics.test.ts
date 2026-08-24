import { beforeEach, describe, expect, it, vi } from "vitest";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import type { AdminAnalyticsSummaryResponse } from "@sattori/shared";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";

const REQUIRED_ENV: Record<string, string> = {
  UPLOAD_BUCKET: "up-bucket",
  OUTPUT_BUCKET: "out-bucket",
  CDN_DOMAIN: "cdn.example.net",
  JOBS_TABLE: "sattori-jobs",
  WORKER_IMAGE: "123456789012.dkr.ecr.us-east-1.amazonaws.com/sattori-worker:latest",
  TITLE_ASSETS_BUCKET: "title-assets-bucket",
  WORKER_LOG_GROUP: "/sattori/worker",
  WORKER_SUBNET_IDS: "subnet-xxxx,subnet-yyyy",
  WORKER_LAUNCH_TEMPLATE_ID: "lt-xxxx",
  EMAIL_RATE_LIMIT_TABLE: "email-rate-limit",
  SETTINGS_TABLE: "sattori-settings",
  WORKERS_TABLE: "sattori-workers",
  SES_FROM_ADDRESS: "no-reply@sattori.hakatashi.com",
  SES_REPLY_TO_ADDRESS: "reply@example.com",
  SES_CONFIGURATION_SET: "sattori-config-set",
  WEB_BASE_URL: "https://sattori.hakatashi.com",
  ANALYTICS_EVENTS_TABLE: "sattori-analytics-events",
};

const ddbMock = mockClient(DynamoDBDocumentClient);

function makeEvent(query: Record<string, string> = {}): APIGatewayProxyEventV2 {
  return { queryStringParameters: query } as unknown as APIGatewayProxyEventV2;
}

function parseBody(res: APIGatewayProxyStructuredResultV2): AdminAnalyticsSummaryResponse {
  return JSON.parse(res.body ?? "{}") as AdminAnalyticsSummaryResponse;
}

describe("GET /admin/analytics", () => {
  beforeEach(() => {
    ddbMock.reset();
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    for (const [key, value] of Object.entries(REQUIRED_ENV)) {
      vi.stubEnv(key, value);
    }
  });

  it("daysを省略すると既定日数(30日)で集計する", async () => {
    const { handler } = await import("./getAnalytics.js");
    const res = (await handler(
      makeEvent(),
      {} as never,
      () => {},
    )) as APIGatewayProxyStructuredResultV2;

    expect(res.statusCode).toBe(200);
    const body = parseBody(res);
    expect(body.days).toBe(30);
    expect(body.daily).toHaveLength(30);
  });

  it("daysは上限(90日)へクランプされ、不正値は既定値になる", async () => {
    const { handler } = await import("./getAnalytics.js");

    const clamped = parseBody(
      (await handler(
        makeEvent({ days: "365" }),
        {} as never,
        () => {},
      )) as APIGatewayProxyStructuredResultV2,
    );
    expect(clamped.days).toBe(90);

    const fallback = parseBody(
      (await handler(
        makeEvent({ days: "-1" }),
        {} as never,
        () => {},
      )) as APIGatewayProxyStructuredResultV2,
    );
    expect(fallback.days).toBe(30);
  });

  it("イベントが記録されていれば集計結果に反映される", async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        {
          type: "pageview",
          visitorHash: "abc",
          country: "JP",
          language: "ja",
          browserFamily: "chrome",
          osFamily: "windows",
          path: "/",
          referrerHost: null,
          deviceCategory: "desktop",
        },
      ],
    });

    const { handler } = await import("./getAnalytics.js");
    const res = (await handler(
      makeEvent({ days: "1" }),
      {} as never,
      () => {},
    )) as APIGatewayProxyStructuredResultV2;

    const body = parseBody(res);
    expect(body.totals.pageviews).toBe(1);
    expect(body.totals.uniqueVisitorDays).toBe(1);
  });
});
