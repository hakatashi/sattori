import { beforeEach, describe, expect, it, vi } from "vitest";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import { mockClient } from "aws-sdk-client-mock";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import type { MagicLink } from "../magicLinks.js";

const REQUIRED_ENV: Record<string, string> = {
  UPLOAD_BUCKET: "up-bucket",
  OUTPUT_BUCKET: "out-bucket",
  CDN_DOMAIN: "cdn.example.net",
  JOBS_TABLE: "sattori-jobs",
  WORKER_IMAGE: "123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/sattori-worker:latest",
  WORKER_LOG_GROUP: "/sattori/worker",
  WORKER_SUBNET_IDS: "subnet-xxxx,subnet-yyyy",
  WORKER_LAUNCH_TEMPLATE_ID: "lt-xxxx",
  MAGIC_LINKS_TABLE: "magic-links",
  EMAIL_RATE_LIMIT_TABLE: "email-rate-limit",
  SES_FROM_ADDRESS: "no-reply@sattori.hakatashi.com",
  WEB_BASE_URL: "https://sattori.hakatashi.com",
};

const ddbMock = mockClient(DynamoDBDocumentClient);
const sesMock = mockClient(SESv2Client);

const validMagicLink: MagicLink = {
  token: "token-1",
  jobId: "job-1",
  email: "user@example.com",
  replayKey: "replays/abc.rpy",
  game: "th07",
  options: { watermark: true },
  estimatedDurationSeconds: 900,
  createdAt: "2026-07-18T00:00:00.000Z",
  expiresAt: "2000-01-01T00:00:00.000Z", // 期限切れでも再送できることを確認するため過去日時
  usedAt: null,
};

function makeEvent(jobId: string, body: unknown): APIGatewayProxyEventV2 {
  return {
    body: JSON.stringify(body),
    isBase64Encoded: false,
    pathParameters: { jobId },
  } as unknown as APIGatewayProxyEventV2;
}

function parseBody(res: APIGatewayProxyStructuredResultV2): unknown {
  return JSON.parse(res.body ?? "{}");
}

describe("POST /jobs/{jobId}/resend", () => {
  beforeEach(() => {
    vi.resetModules();
    ddbMock.reset();
    sesMock.reset();
    for (const [key, value] of Object.entries(REQUIRED_ENV)) {
      vi.stubEnv(key, value);
    }
    ddbMock.on(QueryCommand).resolves({ Count: 0 });
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({});
    sesMock.on(SendEmailCommand).resolves({});
  });

  it("未使用トークンなら期限切れでも有効期限を延長し再送する", async () => {
    ddbMock.on(GetCommand).resolves({ Item: validMagicLink });

    const { handler } = await import("./resendMagicLink.js");
    const res = await handler(makeEvent("job-1", { token: "token-1" }), {} as never, () => {});
    const result = res as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(202);
    expect(sesMock.commandCalls(SendEmailCommand)).toHaveLength(1);
    const updateCall = ddbMock.commandCalls(UpdateCommand)[0];
    expect(updateCall?.args[0].input.UpdateExpression).toContain("expiresAt");
  });

  it("トークンが存在しなければ404を返す", async () => {
    ddbMock.on(GetCommand).resolves({});
    const { handler } = await import("./resendMagicLink.js");
    const res = await handler(makeEvent("job-1", { token: "missing" }), {} as never, () => {});
    expect((res as APIGatewayProxyStructuredResultV2).statusCode).toBe(404);
  });

  it("使用済みトークンなら409を返しメールを送らない", async () => {
    ddbMock
      .on(GetCommand)
      .resolves({ Item: { ...validMagicLink, usedAt: "2026-07-18T01:00:00.000Z" } });
    const { handler } = await import("./resendMagicLink.js");
    const res = await handler(makeEvent("job-1", { token: "token-1" }), {} as never, () => {});
    const result = res as APIGatewayProxyStructuredResultV2;
    expect(result.statusCode).toBe(409);
    expect(sesMock.commandCalls(SendEmailCommand)).toHaveLength(0);
  });

  it("レート制限に達していれば429を返す", async () => {
    ddbMock.on(GetCommand).resolves({ Item: validMagicLink });
    ddbMock.on(QueryCommand).resolves({ Count: 5 });
    const { handler } = await import("./resendMagicLink.js");
    const res = await handler(makeEvent("job-1", { token: "token-1" }), {} as never, () => {});
    const result = res as APIGatewayProxyStructuredResultV2;
    expect(result.statusCode).toBe(429);
    expect(sesMock.commandCalls(SendEmailCommand)).toHaveLength(0);
  });
});
