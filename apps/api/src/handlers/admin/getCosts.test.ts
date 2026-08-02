import { beforeEach, describe, expect, it, vi } from "vitest";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import type { AdminCostSummaryResponse, JobCostInput } from "@sattori/shared";

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
  SES_FROM_ADDRESS: "no-reply@sattori.hakatashi.com",
  WEB_BASE_URL: "https://sattori.hakatashi.com",
};

const ddbMock = mockClient(DynamoDBDocumentClient);

const job: JobCostInput = {
  status: "done",
  game: "th07",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:36:00.000Z",
  launchedAt: "2026-08-01T00:00:00.000Z",
  doneAt: "2026-08-01T00:36:00.000Z",
  instanceId: "i-1",
  instanceType: "c7i.xlarge",
  spotPricePerHour: 0.06,
  outputPath: "outputs/a/original.mp4",
  outputPath720p: "outputs/a/720p.mp4",
  outputBytes: 700 * 1024 * 1024,
  outputBytes720p: 1024 * 1024 * 1024,
};

function makeEvent(query: Record<string, string> = {}): APIGatewayProxyEventV2 {
  return { queryStringParameters: query } as unknown as APIGatewayProxyEventV2;
}

function parseBody(res: APIGatewayProxyStructuredResultV2): AdminCostSummaryResponse {
  return JSON.parse(res.body ?? "{}") as AdminCostSummaryResponse;
}

describe("GET /admin/costs", () => {
  beforeEach(() => {
    ddbMock.reset();
    for (const [key, value] of Object.entries(REQUIRED_ENV)) {
      vi.stubEnv(key, value);
    }
  });

  it("granularity未指定なら月次で集計する", async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [job] });

    const { handler } = await import("./getCosts.js");
    const res = (await handler(
      makeEvent(),
      {} as never,
      () => {},
    )) as APIGatewayProxyStructuredResultV2;

    expect(res.statusCode).toBe(200);
    const body = parseBody(res);
    expect(body.granularity).toBe("monthly");
    expect(body.buckets.map((bucket) => bucket.key)).toEqual(["2026-08"]);
    expect(body.jobCount).toBe(1);
    expect(body.totalJobCount).toBe(1);
    expect(body.buckets[0]?.breakdown.ec2Spot).toBeCloseTo(0.06 * 0.6, 10);
  });

  it("granularityが不正なら400", async () => {
    const { handler } = await import("./getCosts.js");
    const res = (await handler(
      makeEvent({ granularity: "hourly" }),
      {} as never,
      () => {},
    )) as APIGatewayProxyStructuredResultV2;

    expect(res.statusCode).toBe(400);
    expect(ddbMock.commandCalls(ScanCommand)).toHaveLength(0);
  });

  it("limitは上限へクランプされ、不正値は既定値になる", async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: Array.from({ length: 5 }, (_, index) => ({
        ...job,
        launchedAt: `2026-08-0${index + 1}T00:00:00.000Z`,
        doneAt: `2026-08-0${index + 1}T00:36:00.000Z`,
      })),
    });

    const { handler } = await import("./getCosts.js");
    const limited = parseBody(
      (await handler(
        makeEvent({ granularity: "daily", limit: "2" }),
        {} as never,
        () => {},
      )) as APIGatewayProxyStructuredResultV2,
    );
    expect(limited.buckets).toHaveLength(2);

    const fallback = parseBody(
      (await handler(
        makeEvent({ granularity: "daily", limit: "-1" }),
        {} as never,
        () => {},
      )) as APIGatewayProxyStructuredResultV2,
    );
    expect(fallback.buckets).toHaveLength(5);
  });
});
