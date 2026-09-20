import { beforeEach, describe, expect, it, vi } from "vitest";
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import type { JobRecord } from "@sattori/shared";
import { createJobRecord } from "../../testSupport/jobRecord.js";

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

const cpuJob: JobRecord = createJobRecord({ game: "th07", status: "queued" });
const gpuJob: JobRecord = createJobRecord({ game: "th15", status: "queued" });

beforeEach(() => {
  for (const [key, value] of Object.entries(REQUIRED_ENV)) {
    vi.stubEnv(key, value);
  }
  ddbMock.reset();
});

describe("sfn/acquireGpuSlot handler（Issue #270）", () => {
  it("非GPUジョブはGpuSlotsTableへ一切書き込まず即座にacquired:trueを返す", async () => {
    ddbMock.on(GetCommand).resolves({ Item: cpuJob });

    const { handler } = await import("./acquireGpuSlot.js");
    const result = await handler({
      jobId: "job-1",
      attempt: 1,
      executionStartTime: new Date().toISOString(),
    });

    expect(result).toEqual({
      jobId: "job-1",
      attempt: 1,
      acquired: true,
      timedOut: false,
      waitSeconds: 0,
    });
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it("GPUジョブで空きがあれば確保しacquired:trueを返す", async () => {
    ddbMock.on(GetCommand).resolves({ Item: gpuJob });
    ddbMock.on(QueryCommand).resolves({ Items: [{ slotKey: "gpu", itemKey: "#quota", usedVcpu: 0 }] });
    ddbMock.on(TransactWriteCommand).resolves({});

    const { handler } = await import("./acquireGpuSlot.js");
    const result = await handler({
      jobId: "job-1",
      attempt: 1,
      executionStartTime: new Date().toISOString(),
    });

    expect(result.acquired).toBe(true);
    expect(result.timedOut).toBe(false);
    const transactInput = ddbMock.commandCalls(TransactWriteCommand)[0]?.args[0].input;
    // 空き8vCPUなら最大値(8)を仮予約する。
    expect(transactInput?.TransactItems?.[0]?.Put?.Item?.vcpu).toBe(8);
  });

  it("GPUジョブで空きが無ければ待機を返す(acquired:false、待機秒数はnextPollIntervalSeconds)", async () => {
    ddbMock.on(GetCommand).resolves({ Item: gpuJob });
    ddbMock.on(QueryCommand).resolves({ Items: [{ slotKey: "gpu", itemKey: "#quota", usedVcpu: 8 }] });

    const { handler } = await import("./acquireGpuSlot.js");
    const result = await handler({
      jobId: "job-1",
      attempt: 1,
      executionStartTime: new Date().toISOString(),
    });

    expect(result.acquired).toBe(false);
    expect(result.timedOut).toBe(false);
    // 待機開始直後(経過0秒)はnextPollIntervalSeconds(0)=15秒
    expect(result.waitSeconds).toBe(15);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it("初回試行(attempt:1)で残り4vCPUなら4vCPUのみ確保を試みる(投機的並列化)", async () => {
    ddbMock.on(GetCommand).resolves({ Item: gpuJob });
    ddbMock.on(QueryCommand).resolves({ Items: [{ slotKey: "gpu", itemKey: "#quota", usedVcpu: 4 }] });
    ddbMock.on(TransactWriteCommand).resolves({});

    const { handler } = await import("./acquireGpuSlot.js");
    await handler({ jobId: "job-1", attempt: 1, executionStartTime: new Date().toISOString() });

    const transactInput = ddbMock.commandCalls(TransactWriteCommand)[0]?.args[0].input;
    expect(transactInput?.TransactItems?.[0]?.Put?.Item?.vcpu).toBe(4);
  });

  it("リトライ時(attempt>1)は4vCPUしか空いていなければ確保せず8vCPUが空くまで待機する", async () => {
    ddbMock.on(GetCommand).resolves({ Item: gpuJob });
    ddbMock.on(QueryCommand).resolves({ Items: [{ slotKey: "gpu", itemKey: "#quota", usedVcpu: 4 }] });

    const { handler } = await import("./acquireGpuSlot.js");
    const result = await handler({ jobId: "job-1", attempt: 2, executionStartTime: new Date().toISOString() });

    expect(result.acquired).toBe(false);
    expect(result.timedOut).toBe(false);
    expect(result.waitSeconds).toBe(15);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it("リトライ時(attempt>1)でも8vCPU空いていれば確保する", async () => {
    ddbMock.on(GetCommand).resolves({ Item: gpuJob });
    ddbMock.on(QueryCommand).resolves({ Items: [{ slotKey: "gpu", itemKey: "#quota", usedVcpu: 0 }] });
    ddbMock.on(TransactWriteCommand).resolves({});

    const { handler } = await import("./acquireGpuSlot.js");
    const result = await handler({ jobId: "job-1", attempt: 2, executionStartTime: new Date().toISOString() });

    expect(result.acquired).toBe(true);
    expect(result.timedOut).toBe(false);
    const transactInput = ddbMock.commandCalls(TransactWriteCommand)[0]?.args[0].input;
    expect(transactInput?.TransactItems?.[0]?.Put?.Item?.vcpu).toBe(8);
  });

  it("待機の上限(120分)を超えたらfailedを書きtimedOut:trueを返す", async () => {
    ddbMock.on(GetCommand).resolves({ Item: gpuJob });
    ddbMock.on(UpdateCommand).resolves({});

    const { handler } = await import("./acquireGpuSlot.js");
    const executionStartTime = new Date(Date.now() - 121 * 60 * 1000).toISOString();
    const result = await handler({ jobId: "job-1", attempt: 1, executionStartTime });

    expect(result).toEqual({
      jobId: "job-1",
      attempt: 1,
      acquired: false,
      timedOut: true,
      waitSeconds: 0,
    });
    const updateInput = ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input;
    expect(updateInput?.ExpressionAttributeValues?.[":ec"]).toBe("gpu_queue_timeout");
    expect(updateInput?.ExpressionAttributeValues?.[":s"]).toBe("failed");
    // タイムアウト確定時はGpuSlotsTableへ問い合わせない。
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
  });

  it("120分未満ならタイムアウトにならない", async () => {
    ddbMock.on(GetCommand).resolves({ Item: gpuJob });
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(TransactWriteCommand).resolves({});

    const { handler } = await import("./acquireGpuSlot.js");
    const executionStartTime = new Date(Date.now() - 119 * 60 * 1000).toISOString();
    const result = await handler({ jobId: "job-1", attempt: 1, executionStartTime });

    expect(result.timedOut).toBe(false);
  });

  it("ジョブが見つからなければ例外を投げる", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    const { handler } = await import("./acquireGpuSlot.js");
    await expect(
      handler({ jobId: "missing", attempt: 1, executionStartTime: new Date().toISOString() }),
    ).rejects.toThrow(/ジョブが見つかりません/);
  });
});
