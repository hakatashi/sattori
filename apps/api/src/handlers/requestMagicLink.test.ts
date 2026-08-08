import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import { mockClient } from "aws-sdk-client-mock";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";

const REQUIRED_ENV: Record<string, string> = {
  UPLOAD_BUCKET: "up-bucket",
  OUTPUT_BUCKET: "out-bucket",
  CDN_DOMAIN: "cdn.example.net",
  JOBS_TABLE: "sattori-jobs",
  WORKER_IMAGE: "123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/sattori-worker:latest",
  TITLE_ASSETS_BUCKET: "title-assets-bucket",
  WORKER_LOG_GROUP: "/sattori/worker",
  WORKER_SUBNET_IDS: "subnet-xxxx,subnet-yyyy",
  WORKER_LAUNCH_TEMPLATE_ID: "lt-xxxx",
  EMAIL_RATE_LIMIT_TABLE: "email-rate-limit",
  SETTINGS_TABLE: "sattori-settings",
  WORKERS_TABLE: "sattori-workers",
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
    ddbMock.on(UpdateCommand).resolves({}); // レート制限カウンタの記録
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(DeleteCommand).resolves({});
    // キルスイッチ設定(GetCommand)は既定で未作成(Item無し)=受付中として扱われる。
    ddbMock.on(GetCommand).resolves({});
    // 月間コストガードの当月コスト算出(adminCosts.tsの全件Scan)は既定でジョブ0件=$0。
    ddbMock.on(ScanCommand).resolves({ Items: [] });
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

    const putCalls = ddbMock.commandCalls(PutCommand); // job(pending)
    expect(putCalls).toHaveLength(1);
    const jobPut = putCalls.find((call) => call.args[0].input.Item?.status === "pending");
    expect(jobPut?.args[0].input.Item).toMatchObject({
      status: "pending",
      email: "user@example.com",
      replayKey: "replays/abc.rpy",
      language: "ja", // 未指定時は既定言語(ja)
    });
    expect(jobPut?.args[0].input.ConditionExpression).toBe("attribute_not_exists(jobId)");

    const sendCalls = sesMock.commandCalls(SendEmailCommand);
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]?.args[0].input.Destination?.ToAddresses).toEqual(["user@example.com"]);
    // メール本文にジョブページ(/jobs/{jobId})へのリンクは含むが、token相当のパラメータは含まない。
    const emailBody = sendCalls[0]?.args[0].input.Content?.Simple?.Body?.Text?.Data ?? "";
    expect(emailBody).toContain(`/jobs/${jobPut?.args[0].input.Item?.jobId}`);
    expect(emailBody).not.toContain("token=");
  });

  it("language: enを指定すればジョブに保存し、英語の文面・/enリンクでメールを送る", async () => {
    const { handler } = await import("./requestMagicLink.js");
    const res = await handler(
      makeEvent({
        replayKey: "replays/abc.rpy",
        options: { watermark: true },
        email: "user@example.com",
        language: "en",
      }),
      {} as never,
      () => {},
    );
    expect((res as APIGatewayProxyStructuredResultV2).statusCode).toBe(202);

    const putCalls = ddbMock.commandCalls(PutCommand);
    const jobPut = putCalls.find((call) => call.args[0].input.Item?.status === "pending");
    expect(jobPut?.args[0].input.Item?.language).toBe("en");

    const sendCalls = sesMock.commandCalls(SendEmailCommand);
    expect(sendCalls[0]?.args[0].input.Content?.Simple?.Subject?.Data).not.toMatch(/録画/);
    const emailBody = sendCalls[0]?.args[0].input.Content?.Simple?.Body?.Text?.Data ?? "";
    expect(emailBody).toContain(`/en/jobs/${jobPut?.args[0].input.Item?.jobId}`);
  });

  it("不正なlanguageが渡されれば既定言語(ja)にフォールバックする", async () => {
    const { handler } = await import("./requestMagicLink.js");
    const res = await handler(
      makeEvent({
        replayKey: "replays/abc.rpy",
        options: { watermark: true },
        email: "user@example.com",
        language: "fr",
      }),
      {} as never,
      () => {},
    );
    expect((res as APIGatewayProxyStructuredResultV2).statusCode).toBe(202);

    const putCalls = ddbMock.commandCalls(PutCommand);
    const jobPut = putCalls.find((call) => call.args[0].input.Item?.status === "pending");
    expect(jobPut?.args[0].input.Item?.language).toBe("ja");
  });

  it("replayInfoが渡されればジョブレコードにそのまま転記する", async () => {
    const { handler } = await import("./requestMagicLink.js");
    const replayInfo = {
      game: "th07" as const,
      player: "koyi",
      date: "01/18",
      character: "MarisaA",
      difficulty: "Extra",
      stage: null,
      score: 303766040,
      cleared: true,
      estimatedDurationSeconds: 847,
    };
    const res = await handler(
      makeEvent({
        replayKey: "replays/abc.rpy",
        options: { watermark: true },
        email: "user@example.com",
        replayInfo,
      }),
      {} as never,
      () => {},
    );
    expect((res as APIGatewayProxyStructuredResultV2).statusCode).toBe(202);

    const putCalls = ddbMock.commandCalls(PutCommand);
    const jobPut = putCalls.find((call) => call.args[0].input.Item?.status === "pending");
    expect(jobPut?.args[0].input.Item?.replayInfo).toEqual(replayInfo);
  });

  it("replayInfoが無ければnullとして保存する", async () => {
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
    expect((res as APIGatewayProxyStructuredResultV2).statusCode).toBe(202);

    const putCalls = ddbMock.commandCalls(PutCommand);
    const jobPut = putCalls.find((call) => call.args[0].input.Item?.status === "pending");
    expect(jobPut?.args[0].input.Item?.replayInfo).toBeNull();
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
        game: "th13",
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
    ddbMock.on(UpdateCommand).rejects(
      new ConditionalCheckFailedException({ message: "condition failed", $metadata: {} }),
    );
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

  it("ジョブレコードの作成に失敗すれば500を返しメールを送らない", async () => {
    ddbMock.on(PutCommand).rejects(new Error("DynamoDB unavailable"));
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
    expect(result.statusCode).toBe(500);
    expect(sesMock.commandCalls(SendEmailCommand)).toHaveLength(0);
  });

  it("メール送信に失敗すれば502を返し、作成済みのジョブを削除する", async () => {
    sesMock.on(SendEmailCommand).rejects(new Error("SES unavailable"));
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
    expect(result.statusCode).toBe(502);

    const putCalls = ddbMock.commandCalls(PutCommand);
    const deleteCalls = ddbMock.commandCalls(DeleteCommand);
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0]?.args[0].input.Key).toEqual({
      jobId: putCalls[0]?.args[0].input.Item?.jobId,
    });
  });

  it("キルスイッチが停止中(acceptingNewJobs:false)なら503を返し、メール送信もレート制限の消費もしない(Issue #14)", async () => {
    ddbMock
      .on(GetCommand)
      .resolves({ Item: { settingKey: "global", acceptingNewJobs: false, monthlyCostLimitUsd: 50 } });
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
    expect(result.statusCode).toBe(503);
    expect(parseBody(result)).toMatchObject({ code: "service_paused" });
    expect(sesMock.commandCalls(SendEmailCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it("当月の推定コストが月間上限額に達していれば503を返し、メールを送らない(Issue #14)", async () => {
    ddbMock
      .on(GetCommand)
      .resolves({ Item: { settingKey: "global", acceptingNewJobs: true, monthlyCostLimitUsd: 0.0001 } });
    const now = new Date();
    ddbMock.on(ScanCommand).resolves({
      Items: [
        {
          status: "done",
          game: "th07",
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
          launchedAt: null,
          doneAt: null,
          instanceId: null,
          instanceType: null,
          spotPricePerHour: null,
          outputPath: null,
          outputPath720p: null,
          outputBytes: null,
          outputBytes720p: null,
        },
      ],
    });
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
    expect(result.statusCode).toBe(503);
    expect(parseBody(result)).toMatchObject({ code: "monthly_cost_limit_reached" });
    expect(sesMock.commandCalls(SendEmailCommand)).toHaveLength(0);
  });
});
