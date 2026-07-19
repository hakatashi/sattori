import { beforeEach, describe, expect, it, vi } from "vitest";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
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
  STATE_MACHINE_ARN: "arn:aws:states:us-east-1:123456789012:stateMachine:RecordingStateMachine",
};

const ddbMock = mockClient(DynamoDBDocumentClient);
const sfnMock = mockClient(SFNClient);

const validMagicLink: MagicLink = {
  token: "token-1",
  jobId: "job-1",
  email: "user@example.com",
  replayKey: "replays/abc.rpy",
  game: "th07",
  options: { watermark: true },
  estimatedDurationSeconds: 900,
  createdAt: "2026-07-18T00:00:00.000Z",
  expiresAt: "2099-01-01T00:00:00.000Z",
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

describe("POST /jobs/{jobId}/confirm", () => {
  beforeEach(() => {
    vi.resetModules();
    ddbMock.reset();
    sfnMock.reset();
    vi.useRealTimers();
    for (const [key, value] of Object.entries(REQUIRED_ENV)) {
      vi.stubEnv(key, value);
    }
  });

  it("有効なトークンならジョブを作成しStep Functionsを起動して202を返す", async () => {
    ddbMock.on(GetCommand).resolves({ Item: validMagicLink });
    ddbMock.on(UpdateCommand).resolves({});
    ddbMock.on(PutCommand).resolves({});
    sfnMock.on(StartExecutionCommand).resolves({ executionArn: "arn:exec", startDate: new Date() });

    const { handler } = await import("./confirmJob.js");
    const res = await handler(makeEvent("job-1", { token: "token-1" }), {} as never, () => {});
    const result = res as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(202);
    expect(parseBody(result)).toMatchObject({ jobId: "job-1", status: "queued" });

    const putCall = ddbMock.commandCalls(PutCommand)[0];
    expect(putCall?.args[0].input.Item).toMatchObject({
      jobId: "job-1",
      email: "user@example.com",
      status: "queued",
    });
    expect(sfnMock.commandCalls(StartExecutionCommand)).toHaveLength(1);
  });

  it("トークンが存在しなければ404を返す", async () => {
    ddbMock.on(GetCommand).resolves({});
    const { handler } = await import("./confirmJob.js");
    const res = await handler(makeEvent("job-1", { token: "missing" }), {} as never, () => {});
    expect((res as APIGatewayProxyStructuredResultV2).statusCode).toBe(404);
  });

  it("トークンのjobIdがパスと一致しなければ404を返す", async () => {
    ddbMock.on(GetCommand).resolves({ Item: validMagicLink });
    const { handler } = await import("./confirmJob.js");
    const res = await handler(makeEvent("other-job", { token: "token-1" }), {} as never, () => {});
    expect((res as APIGatewayProxyStructuredResultV2).statusCode).toBe(404);
  });

  it("使用済みトークンなら409を返す", async () => {
    ddbMock
      .on(GetCommand)
      .resolves({ Item: { ...validMagicLink, usedAt: "2026-07-18T01:00:00.000Z" } });
    const { handler } = await import("./confirmJob.js");
    const res = await handler(makeEvent("job-1", { token: "token-1" }), {} as never, () => {});
    const result = res as APIGatewayProxyStructuredResultV2;
    expect(result.statusCode).toBe(409);
    expect(parseBody(result)).toMatchObject({ code: "token_already_used" });
  });

  it("期限切れトークンなら410を返す", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { ...validMagicLink, expiresAt: "2000-01-01T00:00:00.000Z" },
    });
    const { handler } = await import("./confirmJob.js");
    const res = await handler(makeEvent("job-1", { token: "token-1" }), {} as never, () => {});
    const result = res as APIGatewayProxyStructuredResultV2;
    expect(result.statusCode).toBe(410);
    expect(parseBody(result)).toMatchObject({ code: "token_expired" });
  });

  it("StartExecution失敗時はジョブをfailedにし502を返す", async () => {
    ddbMock.on(GetCommand).resolves({ Item: validMagicLink });
    ddbMock.on(UpdateCommand).resolves({});
    ddbMock.on(PutCommand).resolves({});
    sfnMock.on(StartExecutionCommand).rejects(new Error("boom"));

    const { handler } = await import("./confirmJob.js");
    const res = await handler(makeEvent("job-1", { token: "token-1" }), {} as never, () => {});
    const result = res as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(502);
    const updateCall = ddbMock.commandCalls(UpdateCommand).find(
      (call) => call.args[0].input.ExpressionAttributeValues?.[":s"] === "failed",
    );
    expect(updateCall).toBeTruthy();
  });
});
