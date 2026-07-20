import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";

const FIXTURES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/replay-parser/test-fixtures",
);
const TH07_FIXTURE = path.join(FIXTURES_DIR, "th07/th7_07.rpy");
// th11 はパーサーとしては認識できるが Sattori の録画対応タイトルには含まれない。
const TH11_FIXTURE = path.join(FIXTURES_DIR, "th11/th11_01.rpy");

const s3Mock = mockClient(S3Client);

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

function makeEvent(body: unknown): APIGatewayProxyEventV2 {
  return { body: JSON.stringify(body), isBase64Encoded: false } as APIGatewayProxyEventV2;
}

function parseBody(res: APIGatewayProxyStructuredResultV2): unknown {
  return JSON.parse(res.body ?? "{}");
}

function mockUploadedReplay(data: Uint8Array) {
  s3Mock.on(GetObjectCommand).resolves({
    Body: { transformToByteArray: async () => data } as never,
  });
}

describe("POST /replays/parse", () => {
  beforeEach(() => {
    vi.resetModules();
    s3Mock.reset();
    for (const [key, value] of Object.entries(REQUIRED_ENV)) {
      vi.stubEnv(key, value);
    }
  });

  it("th07リプレイを解析して ReplayInfo を返す", async () => {
    const { handler } = await import("./parseReplay.js");
    mockUploadedReplay(new Uint8Array(await readFile(TH07_FIXTURE)));

    const res = await handler(makeEvent({ replayKey: "replays/th07.rpy" }), {} as never, () => {});
    expect(res).toBeTruthy();
    const result = res as APIGatewayProxyStructuredResultV2;
    expect(result.statusCode).toBe(200);
    expect(parseBody(result)).toMatchObject({
      game: "th07",
      character: "MarisaA",
      difficulty: "Extra",
      score: 303766040,
      cleared: true,
    });
  });

  it("録画未対応タイトル（th11）は422でエラーを返す", async () => {
    const { handler } = await import("./parseReplay.js");
    mockUploadedReplay(new Uint8Array(await readFile(TH11_FIXTURE)));

    const res = await handler(makeEvent({ replayKey: "replays/th11.rpy" }), {} as never, () => {});
    const result = res as APIGatewayProxyStructuredResultV2;
    expect(result.statusCode).toBe(422);
    expect(parseBody(result)).toMatchObject({ code: "unsupported_game" });
  });

  it("破損ファイルは422でエラーを返す", async () => {
    const { handler } = await import("./parseReplay.js");
    mockUploadedReplay(new Uint8Array([0, 1, 2, 3]));

    const res = await handler(makeEvent({ replayKey: "replays/broken.rpy" }), {} as never, () => {});
    const result = res as APIGatewayProxyStructuredResultV2;
    expect(result.statusCode).toBe(422);
    expect(parseBody(result)).toMatchObject({ code: "unknown_magic" });
  });

  it("replayKey が無ければ400を返す", async () => {
    const { handler } = await import("./parseReplay.js");
    const res = await handler(makeEvent({}), {} as never, () => {});
    const result = res as APIGatewayProxyStructuredResultV2;
    expect(result.statusCode).toBe(400);
  });

  it("S3にオブジェクトが存在しなければ404を返す", async () => {
    const { handler } = await import("./parseReplay.js");
    s3Mock.on(GetObjectCommand).rejects(new Error("NoSuchKey"));

    const res = await handler(makeEvent({ replayKey: "replays/missing.rpy" }), {} as never, () => {});
    const result = res as APIGatewayProxyStructuredResultV2;
    expect(result.statusCode).toBe(404);
  });
});
