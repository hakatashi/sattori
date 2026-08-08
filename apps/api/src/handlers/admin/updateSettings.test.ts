import { beforeEach, describe, expect, it, vi } from "vitest";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
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

function makeEvent(body: unknown): APIGatewayProxyEventV2 {
  return { body: JSON.stringify(body), isBase64Encoded: false } as APIGatewayProxyEventV2;
}

function parseBody(res: APIGatewayProxyStructuredResultV2): AdminSettingsResponse {
  return JSON.parse(res.body ?? "{}") as AdminSettingsResponse;
}

describe("POST /admin/settings", () => {
  beforeEach(() => {
    ddbMock.reset();
    for (const [key, value] of Object.entries(REQUIRED_ENV)) {
      vi.stubEnv(key, value);
    }
    ddbMock.on(GetCommand).resolves({
      Item: { settingKey: "global", acceptingNewJobs: true, monthlyCostLimitUsd: 50 },
    });
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(ScanCommand).resolves({ Items: [] });
  });

  it("acceptingNewJobsを更新できる(キルスイッチ、Issue #14)", async () => {
    const { handler } = await import("./updateSettings.js");
    const res = (await handler(
      makeEvent({ acceptingNewJobs: false }),
      {} as never,
      () => {},
    )) as APIGatewayProxyStructuredResultV2;

    expect(res.statusCode).toBe(200);
    const body = parseBody(res);
    expect(body.acceptingNewJobs).toBe(false);
    expect(body.monthlyCostLimitUsd).toBe(50);

    const putCalls = ddbMock.commandCalls(PutCommand);
    expect(putCalls[0]?.args[0].input.Item).toMatchObject({ acceptingNewJobs: false });
  });

  it("monthlyCostLimitUsdを更新できる", async () => {
    const { handler } = await import("./updateSettings.js");
    const res = (await handler(
      makeEvent({ monthlyCostLimitUsd: 100 }),
      {} as never,
      () => {},
    )) as APIGatewayProxyStructuredResultV2;

    expect(res.statusCode).toBe(200);
    expect(parseBody(res).monthlyCostLimitUsd).toBe(100);
  });

  it("両方とも未指定なら400", async () => {
    const { handler } = await import("./updateSettings.js");
    const res = (await handler(makeEvent({}), {} as never, () => {})) as
      APIGatewayProxyStructuredResultV2;

    expect(res.statusCode).toBe(400);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  it("monthlyCostLimitUsdが0以下なら400", async () => {
    const { handler } = await import("./updateSettings.js");
    const res = (await handler(
      makeEvent({ monthlyCostLimitUsd: 0 }),
      {} as never,
      () => {},
    )) as APIGatewayProxyStructuredResultV2;

    expect(res.statusCode).toBe(400);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  it("acceptingNewJobsがboolean以外なら400", async () => {
    const { handler } = await import("./updateSettings.js");
    const res = (await handler(
      makeEvent({ acceptingNewJobs: "false" }),
      {} as never,
      () => {},
    )) as APIGatewayProxyStructuredResultV2;

    expect(res.statusCode).toBe(400);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });
});
