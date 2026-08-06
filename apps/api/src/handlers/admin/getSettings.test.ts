import { beforeEach, describe, expect, it, vi } from "vitest";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { DEFAULT_MONTHLY_COST_LIMIT_USD } from "@sattori/shared";
import type { AdminSettingsResponse } from "@sattori/shared";
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
  SES_FROM_ADDRESS: "no-reply@sattori.hakatashi.com",
  WEB_BASE_URL: "https://sattori.hakatashi.com",
};

const ddbMock = mockClient(DynamoDBDocumentClient);

function parseBody(res: APIGatewayProxyStructuredResultV2): AdminSettingsResponse {
  return JSON.parse(res.body ?? "{}") as AdminSettingsResponse;
}

describe("GET /admin/settings", () => {
  beforeEach(() => {
    ddbMock.reset();
    for (const [key, value] of Object.entries(REQUIRED_ENV)) {
      vi.stubEnv(key, value);
    }
  });

  it("設定未作成なら既定値と当月コスト0を返す", async () => {
    ddbMock.on(GetCommand).resolves({});
    ddbMock.on(ScanCommand).resolves({ Items: [] });

    const { handler } = await import("./getSettings.js");
    const res = (await handler({} as APIGatewayProxyEventV2, {} as never, () => {})) as
      APIGatewayProxyStructuredResultV2;

    expect(res.statusCode).toBe(200);
    const body = parseBody(res);
    expect(body).toEqual({
      acceptingNewJobs: true,
      monthlyCostLimitUsd: DEFAULT_MONTHLY_COST_LIMIT_USD,
      currentMonthCostUsd: 0,
      costLimitReached: false,
    });
  });

  it("当月コストが上限以上ならcostLimitReached:trueを返す", async () => {
    ddbMock
      .on(GetCommand)
      .resolves({ Item: { settingKey: "global", acceptingNewJobs: true, monthlyCostLimitUsd: 0.0001 } });
    ddbMock.on(ScanCommand).resolves({
      Items: [
        {
          status: "done",
          game: "th07",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    });

    const { handler } = await import("./getSettings.js");
    const res = (await handler({} as APIGatewayProxyEventV2, {} as never, () => {})) as
      APIGatewayProxyStructuredResultV2;

    const body = parseBody(res);
    expect(body.costLimitReached).toBe(true);
    expect(body.currentMonthCostUsd).toBeGreaterThan(0);
  });
});
