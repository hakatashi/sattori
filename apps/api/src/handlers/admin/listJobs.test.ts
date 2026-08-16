import { beforeEach, describe, expect, it, vi } from "vitest";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import type { AdminJobListResponse, AdminJobSummary } from "@sattori/shared";
import { encodeCursor } from "../../adminJobs.js";

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
  SES_CONFIGURATION_SET: "sattori-config-set",
  WEB_BASE_URL: "https://sattori.hakatashi.com",
};

const ddbMock = mockClient(DynamoDBDocumentClient);

function summary(jobId: string, createdAt: string): AdminJobSummary {
  return {
    jobId,
    game: "th11",
    status: "done",
    createdAt,
    updatedAt: createdAt,
    email: null,
    error: null,
    workerKind: null,
    instanceType: null,
    availabilityZone: null,
    progress: null,
    replayInfo: null,
  };
}

function makeEvent(query: Record<string, string>): APIGatewayProxyEventV2 {
  return { queryStringParameters: query } as unknown as APIGatewayProxyEventV2;
}

function parseBody(res: APIGatewayProxyStructuredResultV2): AdminJobListResponse {
  return JSON.parse(res.body ?? "{}") as AdminJobListResponse;
}

describe("GET /admin/jobs", () => {
  beforeEach(() => {
    ddbMock.reset();
    for (const [key, value] of Object.entries(REQUIRED_ENV)) {
      vi.stubEnv(key, value);
    }
  });

  it("statusを指定した場合はQuery1回でその状態のみ取得する", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [summary("job-1", "2026-07-30T00:00:00.000Z")] });

    const { handler } = await import("./listJobs.js");
    const res = await handler(makeEvent({ status: "done" }), {} as never, () => {});
    const body = parseBody(res as APIGatewayProxyStructuredResultV2);

    expect(body.items.map((i) => i.jobId)).toEqual(["job-1"]);
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(1);
  });

  it("status未指定なら7ステータスぶんQueryする", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const { handler } = await import("./listJobs.js");
    await handler(makeEvent({}), {} as never, () => {});

    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(7);
  });

  it("不正なstatusは400を返す", async () => {
    const { handler } = await import("./listJobs.js");
    const res = (await handler(
      makeEvent({ status: "unknown-status" }),
      {} as never,
      () => {},
    )) as APIGatewayProxyStructuredResultV2;
    expect(res.statusCode).toBe(400);
  });

  // Queryへ渡るLimitはhasMore判定のため常にlimit+1（`adminJobs.ts`参照）。
  it("limitのクランプ: 0は既定値(20)、101は上限(100)になる", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    const { handler } = await import("./listJobs.js");

    await handler(makeEvent({ status: "done", limit: "0" }), {} as never, () => {});
    expect(ddbMock.commandCalls(QueryCommand)[0]?.args[0].input.Limit).toBe(21);

    ddbMock.resetHistory();
    await handler(makeEvent({ status: "done", limit: "101" }), {} as never, () => {});
    expect(ddbMock.commandCalls(QueryCommand)[0]?.args[0].input.Limit).toBe(101);
  });

  it("cursorを渡すとそのstatusのExclusiveStartKeyになる", async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [summary("job-1", "2026-07-30T00:00:01.000Z")],
    });
    const { handler } = await import("./listJobs.js");

    const cursor = encodeCursor({
      done: { createdAt: "2026-07-30T00:00:02.000Z", jobId: "job-2" },
    });
    const res = await handler(makeEvent({ status: "done", cursor }), {} as never, () => {});
    const body = parseBody(res as APIGatewayProxyStructuredResultV2);

    expect(body.items.map((i) => i.jobId)).toEqual(["job-1"]);
    expect(ddbMock.commandCalls(QueryCommand)[0]?.args[0].input.ExclusiveStartKey).toEqual({
      status: "done",
      createdAt: "2026-07-30T00:00:02.000Z",
      jobId: "job-2",
    });
  });

  it("不正なcursorは400を返す", async () => {
    const { handler } = await import("./listJobs.js");
    const res = (await handler(
      makeEvent({ cursor: "!!!not-valid!!!" }),
      {} as never,
      () => {},
    )) as APIGatewayProxyStructuredResultV2;
    expect(res.statusCode).toBe(400);
  });
});
