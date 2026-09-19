import { beforeEach, describe, expect, it, vi } from "vitest";
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";

const REQUIRED_ENV: Record<string, string> = {
  UPLOAD_BUCKET: "up-bucket",
  OUTPUT_BUCKET: "out-bucket",
  CDN_DOMAIN: "cdn.example.net",
  JOBS_TABLE: "sattori-jobs",
  WORKER_IMAGE: "123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/sattori-worker:latest",
  WORKER_GPU_IMAGE: "123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/sattori-worker-gpu:latest",
  TITLE_ASSETS_BUCKET: "title-assets-bucket",
  WORKER_LOG_GROUP: "/sattori/worker",
  WORKER_SUBNET_IDS: "subnet-aaaa,subnet-bbbb",
  WORKER_SUBNET_AZS: "eu-south-2a,eu-south-2b",
  WORKER_LAUNCH_TEMPLATE_ID: "lt-xxxx",
  GPU_WORKER_LAUNCH_TEMPLATE_ID: "lt-gpu-xxxx",
  EMAIL_RATE_LIMIT_TABLE: "email-rate-limit",
  SETTINGS_TABLE: "sattori-settings",
  WORKERS_TABLE: "sattori-workers",
  SES_FROM_ADDRESS: "no-reply@sattori.hakatashi.com",
  SES_REPLY_TO_ADDRESS: "reply@example.com",
  SES_CONFIGURATION_SET: "sattori-config-set",
  WEB_BASE_URL: "https://sattori.hakatashi.com",
  ANALYTICS_EVENTS_TABLE: "sattori-analytics-events",
  GPU_SLOTS_TABLE: "sattori-gpu-slots",
};

const ddbMock = mockClient(DynamoDBDocumentClient);

beforeEach(() => {
  for (const [key, value] of Object.entries(REQUIRED_ENV)) {
    vi.stubEnv(key, value);
  }
  ddbMock.reset();
});

describe("sfn/releaseGpuSlot handler（Issue #270）", () => {
  it("リースが存在すれば返却する", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        slotKey: "gpu",
        itemKey: "job#job-1",
        jobId: "job-1",
        vcpu: 4,
        acquiredAt: "a",
        expiresAt: "b",
        expectedFinishAt: "c",
      },
    });
    ddbMock.on(TransactWriteCommand).resolves({});

    const { handler } = await import("./releaseGpuSlot.js");
    await handler({ jobId: "job-1" });

    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(1);
  });

  it("非GPUジョブ(リースが存在しない)でも安全に呼べる", async () => {
    ddbMock.on(GetCommand).resolves({});

    const { handler } = await import("./releaseGpuSlot.js");
    await expect(handler({ jobId: "job-1" })).resolves.toBeUndefined();
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });
});
