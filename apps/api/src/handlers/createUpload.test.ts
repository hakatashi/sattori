import { beforeEach, describe, expect, it, vi } from "vitest";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";

const REQUIRED_ENV: Record<string, string> = {
  UPLOAD_BUCKET: "up-bucket",
  OUTPUT_BUCKET: "out-bucket",
  CDN_DOMAIN: "cdn.example.net",
  JOBS_TABLE: "sattori-jobs",
  WORKER_IMAGE: "123456789012.dkr.ecr.eu-south-2.amazonaws.com/sattori-worker:latest",
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

function makeEvent(body: unknown): APIGatewayProxyEventV2 {
  return { body: JSON.stringify(body), isBase64Encoded: false } as APIGatewayProxyEventV2;
}

function parseBody(res: APIGatewayProxyStructuredResultV2): unknown {
  return JSON.parse(res.body ?? "{}");
}

describe("POST /uploads", () => {
  beforeEach(() => {
    vi.resetModules();
    for (const [key, value] of Object.entries(REQUIRED_ENV)) {
      vi.stubEnv(key, value);
    }
    vi.stubEnv("AWS_ACCESS_KEY_ID", "dummy");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "dummy");
    vi.stubEnv("AWS_REGION", "eu-south-2");
  });

  it("有効な要求なら署名付きURLとreplayKeyを返す", async () => {
    const { handler } = await import("./createUpload.js");
    const res = await handler(
      makeEvent({ filename: "foo.rpy", size: 1024 }),
      {} as never,
      () => {},
    );
    const result = res as APIGatewayProxyStructuredResultV2;
    expect(result.statusCode).toBe(200);
    const body = parseBody(result) as { replayKey: string; uploadUrl: string };
    expect(body.replayKey).toMatch(/^replays\/[0-9a-f-]{36}\.rpy$/);
    // 署名にContentLengthが焼き込まれている(Issue #128 SEC-2)
    expect(new URL(body.uploadUrl).searchParams.get("X-Amz-SignedHeaders")).toContain(
      "content-length",
    );
  });

  it("sizeが上限を超えていれば413を返す", async () => {
    const { handler } = await import("./createUpload.js");
    const res = await handler(
      makeEvent({ filename: "foo.rpy", size: 5 * 1024 * 1024 + 1 }),
      {} as never,
      () => {},
    );
    expect((res as APIGatewayProxyStructuredResultV2).statusCode).toBe(413);
  });

  it("sizeが整数でなければ413を返す（ContentLengthとして使う値のため）", async () => {
    const { handler } = await import("./createUpload.js");
    const res = await handler(
      makeEvent({ filename: "foo.rpy", size: 1024.5 }),
      {} as never,
      () => {},
    );
    expect((res as APIGatewayProxyStructuredResultV2).statusCode).toBe(413);
  });

  it("sizeが0以下なら413を返す", async () => {
    const { handler } = await import("./createUpload.js");
    const res = await handler(makeEvent({ filename: "foo.rpy", size: 0 }), {} as never, () => {});
    expect((res as APIGatewayProxyStructuredResultV2).statusCode).toBe(413);
  });

  it("拡張子が.rpyでなければ400を返す", async () => {
    const { handler } = await import("./createUpload.js");
    const res = await handler(
      makeEvent({ filename: "foo.txt", size: 1024 }),
      {} as never,
      () => {},
    );
    expect((res as APIGatewayProxyStructuredResultV2).statusCode).toBe(400);
  });

  it("filenameまたはsizeが無ければ400を返す", async () => {
    const { handler } = await import("./createUpload.js");
    const res = await handler(makeEvent({ filename: "foo.rpy" }), {} as never, () => {});
    expect((res as APIGatewayProxyStructuredResultV2).statusCode).toBe(400);
  });
});
