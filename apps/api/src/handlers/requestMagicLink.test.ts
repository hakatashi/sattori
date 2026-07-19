import { beforeEach, describe, expect, it, vi } from "vitest";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import { mockClient } from "aws-sdk-client-mock";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";

const REQUIRED_ENV: Record<string, string> = {
  UPLOAD_BUCKET: "up-bucket",
  OUTPUT_BUCKET: "out-bucket",
  CDN_DOMAIN: "cdn.example.net",
  JOBS_TABLE: "sattori-jobs",
  WORKER_IMAGE: "123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/sattori-worker:latest",
  WORKER_LOG_GROUP: "/sattori/worker",
  WORKER_SUBNET_IDS: "subnet-xxxx,subnet-yyyy",
  WORKER_LAUNCH_TEMPLATE_ID: "lt-xxxx",
  EMAIL_RATE_LIMIT_TABLE: "email-rate-limit",
  SES_FROM_ADDRESS: "no-reply@sattori.hakatashi.com",
  WEB_BASE_URL: "https://sattori.hakatashi.com",
};

const ddbMock = mockClient(DynamoDBDocumentClient);
const sesMock = mockClient(SESv2Client);

function makeEvent(body: unknown): APIGatewayProxyEventV2 {
  return { body: JSON.stringify(body), isBase64Encoded: false } as APIGatewayProxyEventV2;
}

function parseBody(res: APIGatewayProxyStructuredResultV2): unknown {
  return JSON.parse(res.body ?? "{}");
}

describe("POST /magic-links", () => {
  beforeEach(() => {
    vi.resetModules();
    ddbMock.reset();
    sesMock.reset();
    for (const [key, value] of Object.entries(REQUIRED_ENV)) {
      vi.stubEnv(key, value);
    }
    ddbMock.on(QueryCommand).resolves({ Count: 0 });
    ddbMock.on(PutCommand).resolves({});
    sesMock.on(SendEmailCommand).resolves({});
  });

  it("有効な要求ならstatus:pendingのジョブを作成しメールを送信して202を返す", async () => {
    const { handler } = await import("./requestMagicLink.js");
    const res = await handler(
      makeEvent({
        replayKey: "replays/abc.rpy",
        options: { watermark: true },
        email: "user@example.com",
      }),
      {} as never,
      () => {},
    );
    const result = res as APIGatewayProxyStructuredResultV2;
    expect(result.statusCode).toBe(202);
    // jobIdはレスポンスに含めない(メールを確認しないと分からない秘密値のため)。
    expect(parseBody(result)).toEqual({});

    const putCalls = ddbMock.commandCalls(PutCommand); // rate limit + job(pending)
    expect(putCalls).toHaveLength(2);
    const jobPut = putCalls.find((call) => call.args[0].input.Item?.status === "pending");
    expect(jobPut?.args[0].input.Item).toMatchObject({
      status: "pending",
      email: "user@example.com",
      replayKey: "replays/abc.rpy",
    });
    expect(jobPut?.args[0].input.ConditionExpression).toBe("attribute_not_exists(jobId)");

    const sendCalls = sesMock.commandCalls(SendEmailCommand);
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]?.args[0].input.Destination?.ToAddresses).toEqual(["user@example.com"]);
    // メール本文にjobIdへのリンクは含むが、token相当のパラメータは含まない。
    const emailBody = sendCalls[0]?.args[0].input.Content?.Simple?.Body?.Text?.Data ?? "";
    expect(emailBody).toContain(`jobId=${jobPut?.args[0].input.Item?.jobId}`);
    expect(emailBody).not.toContain("token=");
  });

  it("email の形式が不正なら400を返しメールを送らない", async () => {
    const { handler } = await import("./requestMagicLink.js");
    const res = await handler(
      makeEvent({ replayKey: "replays/abc.rpy", options: { watermark: true }, email: "not-an-email" }),
      {} as never,
      () => {},
    );
    const result = res as APIGatewayProxyStructuredResultV2;
    expect(result.statusCode).toBe(400);
    expect(sesMock.commandCalls(SendEmailCommand)).toHaveLength(0);
  });

  it("replayKey が無ければ400を返す", async () => {
    const { handler } = await import("./requestMagicLink.js");
    const res = await handler(
      makeEvent({ options: { watermark: true }, email: "user@example.com" }),
      {} as never,
      () => {},
    );
    expect((res as APIGatewayProxyStructuredResultV2).statusCode).toBe(400);
  });

  it("非対応タイトルなら422を返す", async () => {
    const { handler } = await import("./requestMagicLink.js");
    const res = await handler(
      makeEvent({
        replayKey: "replays/abc.rpy",
        game: "th11",
        options: { watermark: true },
        email: "user@example.com",
      }),
      {} as never,
      () => {},
    );
    const result = res as APIGatewayProxyStructuredResultV2;
    expect(result.statusCode).toBe(422);
    expect(parseBody(result)).toMatchObject({ code: "unsupported_game" });
  });

  it("レート制限に達していれば429を返しメールを送らない", async () => {
    ddbMock.on(QueryCommand).resolves({ Count: 5 });
    const { handler } = await import("./requestMagicLink.js");
    const res = await handler(
      makeEvent({
        replayKey: "replays/abc.rpy",
        options: { watermark: true },
        email: "user@example.com",
      }),
      {} as never,
      () => {},
    );
    const result = res as APIGatewayProxyStructuredResultV2;
    expect(result.statusCode).toBe(429);
    expect(sesMock.commandCalls(SendEmailCommand)).toHaveLength(0);
  });
});
