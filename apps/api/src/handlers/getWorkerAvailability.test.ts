import { beforeEach, describe, expect, it, vi } from "vitest";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import {
  WORKER_HEARTBEAT_FRESH_SECONDS,
  type GetWorkerAvailabilityResponse,
  type WorkerHeartbeat,
} from "@sattori/shared";

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
  WEB_BASE_URL: "https://sattori.hakatashi.com",
};

const ddbMock = mockClient(DynamoDBDocumentClient);
const NOW = new Date("2026-08-11T12:00:00.000Z");

function heartbeat(overrides: Partial<WorkerHeartbeat> = {}): WorkerHeartbeat {
  return {
    workerId: "home-1",
    kind: "home",
    lastHeartbeatAt: NOW.toISOString(),
    accepting: true,
    activeJobs: 0,
    maxConcurrency: 2,
    supportedGames: ["th06", "th07", "th08", "th11", "th20"],
    capabilities: ["slow-motion-recording"],
    ttl: Math.floor(NOW.getTime() / 1000) + 900,
    ...overrides,
  };
}

async function invoke(): Promise<APIGatewayProxyStructuredResultV2> {
  const { handler } = await import("./getWorkerAvailability.js");
  return (await handler(
    {} as APIGatewayProxyEventV2,
    {} as never,
    () => {},
  )) as APIGatewayProxyStructuredResultV2;
}

function parseBody(res: APIGatewayProxyStructuredResultV2): GetWorkerAvailabilityResponse {
  return JSON.parse(res.body ?? "{}") as GetWorkerAvailabilityResponse;
}

describe("GET /worker-availability", () => {
  beforeEach(() => {
    vi.resetModules();
    ddbMock.reset();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    for (const [key, value] of Object.entries(REQUIRED_ENV)) {
      vi.stubEnv(key, value);
    }
  });

  it("空きのある新鮮なワーカーがいれば、その能力の和集合を返す", async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [heartbeat()] });

    const res = await invoke();

    expect(res.statusCode).toBe(200);
    expect(parseBody(res)).toEqual({
      available: true,
      capabilities: ["slow-motion-recording"],
    });
  });

  it("ハートビートが古いワーカーは数えない", async () => {
    const stale = new Date(NOW.getTime() - (WORKER_HEARTBEAT_FRESH_SECONDS + 10) * 1000);
    ddbMock.on(ScanCommand).resolves({ Items: [heartbeat({ lastHeartbeatAt: stale.toISOString() })] });

    expect(parseBody(await invoke())).toEqual({ available: false, capabilities: [] });
  });

  it("受付停止中(ドレイン中など)のワーカーは数えない", async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [heartbeat({ accepting: false })] });

    expect(parseBody(await invoke())).toEqual({ available: false, capabilities: [] });
  });

  it("同時実行の上限に達しているワーカーは数えない", async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [heartbeat({ activeJobs: 2, maxConcurrency: 2 })] });

    expect(parseBody(await invoke())).toEqual({ available: false, capabilities: [] });
  });

  it("ワーカーが1台もいなければ available:false", async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [] });

    expect(parseBody(await invoke())).toEqual({ available: false, capabilities: [] });
  });

  it("能力は空きのあるワーカーぶんだけを重複なく集める", async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [
        heartbeat({ workerId: "home-1" }),
        heartbeat({ workerId: "home-2" }),
        // 埋まっているワーカーの能力は数に入れない。
        heartbeat({ workerId: "home-3", activeJobs: 2, maxConcurrency: 2 }),
      ],
    });

    expect(parseBody(await invoke()).capabilities).toEqual(["slow-motion-recording"]);
  });

  it("ハートビートが読めなくても200で安全側(利用不可)に縮退する", async () => {
    // 低速録画が選べないだけで、ページAのアップロード自体は続けられるべき。
    ddbMock.on(ScanCommand).rejects(new Error("throttled"));

    const res = await invoke();

    expect(res.statusCode).toBe(200);
    expect(parseBody(res)).toEqual({ available: false, capabilities: [] });
  });

  it("workerId・台数・負荷といった運用情報は返さない(認証なしで公開されるため)", async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [heartbeat()] });

    const res = await invoke();

    expect(Object.keys(parseBody(res)).sort()).toEqual(["available", "capabilities"]);
    expect(res.body).not.toContain("home-1");
  });
});
