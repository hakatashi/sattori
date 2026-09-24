import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
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
const gpuJob: JobRecord = createJobRecord({ game: "th15", status: "queued", jobId: "job-1" });

/**
 * `GpuQueueIndex`のQuery結果1件ぶん。`gpuQueuedAtOffsetSec`は現在時刻からの相対
 * オフセット（負値=過去、投入順の古さ）で指定する——staleしきい値
 * （`GPU_QUEUE_STALE_AFTER_SECONDS`）の判定は実際の`Date.now()`基準で行われるため、
 * 固定の過去カレンダー日時を使うとテスト実行時刻との差でstale扱いになってしまう。
 */
function waitingEntry(
  jobId: string,
  gpuQueuedAtOffsetSec: number,
  overrides: { heartbeatAgeSec?: number; estimatedDurationSeconds?: number | null } = {},
) {
  const now = Date.now();
  return {
    jobId,
    gpuQueuedAt: new Date(now + gpuQueuedAtOffsetSec * 1000).toISOString(),
    gpuQueueHeartbeatAt: new Date(now - (overrides.heartbeatAgeSec ?? 0) * 1000).toISOString(),
    estimatedDurationSeconds: overrides.estimatedDurationSeconds ?? null,
  };
}

beforeEach(() => {
  for (const [key, value] of Object.entries(REQUIRED_ENV)) {
    vi.stubEnv(key, value);
  }
  ddbMock.reset();
  // markGpuQueueWaiting: 既定で成功、初回想定でgpuQueueEnteredAt=呼び出し時刻を返す。
  ddbMock.on(UpdateCommand).resolves({ Attributes: {} });
});

describe("sfn/acquireGpuSlot handler（Issue #270）", () => {
  it("非GPUジョブはJobsTableのgpuQueue*属性にもGpuSlotsTableにも一切触れず即座にacquired:trueを返す", async () => {
    ddbMock.on(GetCommand).resolves({ Item: cpuJob });

    const { handler } = await import("./acquireGpuSlot.js");
    const result = await handler({ jobId: "job-1", attempt: 1 });

    expect(result).toEqual({ jobId: "job-1", attempt: 1, acquired: true, timedOut: false, waitSeconds: 0 });
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it("GPUジョブは待機列の先頭かつ空きがあれば確保しacquired:trueを返す(待機列から外れる)", async () => {
    ddbMock.on(GetCommand).resolves({ Item: gpuJob });
    ddbMock.on(QueryCommand, { IndexName: "GpuQueueIndex" }).resolves({
      Items: [waitingEntry("job-1", 0)],
    });
    ddbMock.on(QueryCommand, { TableName: REQUIRED_ENV.GPU_SLOTS_TABLE }).resolves({
      Items: [{ slotKey: "gpu", itemKey: "#quota", usedVcpu: 0 }],
    });
    ddbMock.on(TransactWriteCommand).resolves({});

    const { handler } = await import("./acquireGpuSlot.js");
    const result = await handler({ jobId: "job-1", attempt: 1 });

    expect(result.acquired).toBe(true);
    // 待機列から外す(gpuQueueState等のREMOVE)UpdateItemが呼ばれる。
    const removeCalls = ddbMock
      .commandCalls(UpdateCommand)
      .filter((call) => String(call.args[0].input.UpdateExpression).includes("REMOVE gpuQueueState"));
    expect(removeCalls).toHaveLength(1);
  });

  it("先頭でなければ確保を試みず待機する(投入順=FIFOを守る)", async () => {
    ddbMock.on(GetCommand).resolves({ Item: gpuJob });
    // job-0がjob-1より先に並んでいる(gpuQueuedAtが古い)。
    ddbMock.on(QueryCommand, { IndexName: "GpuQueueIndex" }).resolves({
      Items: [
        waitingEntry("job-0", -60),
        waitingEntry("job-1", 0),
      ],
    });
    ddbMock.on(QueryCommand, { TableName: REQUIRED_ENV.GPU_SLOTS_TABLE }).resolves({ Items: [] });

    const { handler } = await import("./acquireGpuSlot.js");
    const result = await handler({ jobId: "job-1", attempt: 1 });

    expect(result.acquired).toBe(false);
    expect(result.timedOut).toBe(false);
    // 待機開始直後(経過0秒)はnextPollIntervalSeconds(0)=15秒
    expect(result.waitSeconds).toBe(15);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
    // 順位(2番目)・ETAの表示用フィールドを書き込む。
    const displayUpdate = ddbMock
      .commandCalls(UpdateCommand)
      .find((call) => call.args[0].input.ExpressionAttributeValues?.[":p"] !== undefined);
    expect(displayUpdate?.args[0].input.ExpressionAttributeValues?.[":p"]).toBe(2);
  });

  it("GSIの結果整合で自分がQuery結果に現れなくても先頭扱いせず、先行ジョブを追い越さない", async () => {
    ddbMock.on(GetCommand).resolves({ Item: gpuJob });
    // markGpuQueueWaitingの書き込み結果(強整合)ではjob-1はjob-0より後に並んでいる。
    ddbMock.on(UpdateCommand).resolves({ Attributes: { gpuQueuedAt: new Date().toISOString() } });
    // 直後のQueryにはまだjob-1が反映されていない。
    ddbMock.on(QueryCommand, { IndexName: "GpuQueueIndex" }).resolves({
      Items: [waitingEntry("job-0", -60)],
    });
    ddbMock.on(QueryCommand, { TableName: REQUIRED_ENV.GPU_SLOTS_TABLE }).resolves({
      Items: [{ slotKey: "gpu", itemKey: "#quota", usedVcpu: 0 }],
    });
    ddbMock.on(TransactWriteCommand).resolves({});

    const { handler } = await import("./acquireGpuSlot.js");
    const result = await handler({ jobId: "job-1", attempt: 1 });

    expect(result.acquired).toBe(false);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it("枠を確保した際はgpuQueuedAtを残す(リトライで再入してもFIFO順を保つ)", async () => {
    ddbMock.on(GetCommand).resolves({ Item: gpuJob });
    ddbMock.on(QueryCommand, { IndexName: "GpuQueueIndex" }).resolves({
      Items: [waitingEntry("job-1", 0)],
    });
    ddbMock.on(QueryCommand, { TableName: REQUIRED_ENV.GPU_SLOTS_TABLE }).resolves({
      Items: [{ slotKey: "gpu", itemKey: "#quota", usedVcpu: 0 }],
    });
    ddbMock.on(TransactWriteCommand).resolves({});

    const { handler } = await import("./acquireGpuSlot.js");
    const result = await handler({ jobId: "job-1", attempt: 1 });

    expect(result.acquired).toBe(true);
    const removeCall = ddbMock
      .commandCalls(UpdateCommand)
      .find((call) => String(call.args[0].input.UpdateExpression).includes("REMOVE gpuQueueState"));
    expect(String(removeCall?.args[0].input.UpdateExpression)).not.toContain("gpuQueuedAt");
  });

  it("心拍が陳腐化した待機者(死んだ待機者)は先頭判定から除外される(head-of-line blocking対策)", async () => {
    ddbMock.on(GetCommand).resolves({ Item: gpuJob });
    ddbMock.on(QueryCommand, { IndexName: "GpuQueueIndex" }).resolves({
      Items: [
        waitingEntry("job-0", -60, { heartbeatAgeSec: 999_999 }),
        waitingEntry("job-1", 0),
      ],
    });
    ddbMock.on(QueryCommand, { TableName: REQUIRED_ENV.GPU_SLOTS_TABLE }).resolves({
      Items: [{ slotKey: "gpu", itemKey: "#quota", usedVcpu: 0 }],
    });
    ddbMock.on(TransactWriteCommand).resolves({});

    const { handler } = await import("./acquireGpuSlot.js");
    const result = await handler({ jobId: "job-1", attempt: 1 });

    // job-0はstaleなので無視され、job-1が(唯一の生存待機者として)先頭になり確保できる。
    expect(result.acquired).toBe(true);
  });

  it("先頭だが空きが無ければ待機する", async () => {
    ddbMock.on(GetCommand).resolves({ Item: gpuJob });
    ddbMock.on(QueryCommand, { IndexName: "GpuQueueIndex" }).resolves({
      Items: [waitingEntry("job-1", 0)],
    });
    ddbMock.on(QueryCommand, { TableName: REQUIRED_ENV.GPU_SLOTS_TABLE }).resolves({
      Items: [{ slotKey: "gpu", itemKey: "#quota", usedVcpu: 8 }],
    });

    const { handler } = await import("./acquireGpuSlot.js");
    const result = await handler({ jobId: "job-1", attempt: 1 });

    expect(result.acquired).toBe(false);
    expect(result.waitSeconds).toBe(15);
  });

  it("初回試行(attempt:1)で残り4vCPUなら4vCPUのみ確保を試みる(投機的並列化)", async () => {
    ddbMock.on(GetCommand).resolves({ Item: gpuJob });
    ddbMock.on(QueryCommand, { IndexName: "GpuQueueIndex" }).resolves({
      Items: [waitingEntry("job-1", 0)],
    });
    ddbMock.on(QueryCommand, { TableName: REQUIRED_ENV.GPU_SLOTS_TABLE }).resolves({
      Items: [{ slotKey: "gpu", itemKey: "#quota", usedVcpu: 4 }],
    });
    ddbMock.on(TransactWriteCommand).resolves({});

    const { handler } = await import("./acquireGpuSlot.js");
    const result = await handler({ jobId: "job-1", attempt: 1 });

    expect(result.acquired).toBe(true);
    const transactInput = ddbMock.commandCalls(TransactWriteCommand)[0]?.args[0].input;
    expect(transactInput?.TransactItems?.[0]?.Put?.Item?.vcpu).toBe(4);
  });

  it("リトライ時(attempt>1)は4vCPUしか空いていなければ確保せず8vCPUが空くまで待機する", async () => {
    ddbMock.on(GetCommand).resolves({ Item: gpuJob });
    ddbMock.on(QueryCommand, { IndexName: "GpuQueueIndex" }).resolves({
      Items: [waitingEntry("job-1", 0)],
    });
    ddbMock.on(QueryCommand, { TableName: REQUIRED_ENV.GPU_SLOTS_TABLE }).resolves({
      Items: [{ slotKey: "gpu", itemKey: "#quota", usedVcpu: 4 }],
    });

    const { handler } = await import("./acquireGpuSlot.js");
    const result = await handler({ jobId: "job-1", attempt: 2 });

    expect(result.acquired).toBe(false);
    expect(result.timedOut).toBe(false);
    expect(result.waitSeconds).toBe(15);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it("リトライ時(attempt>1)でも8vCPU空いていれば確保する", async () => {
    ddbMock.on(GetCommand).resolves({ Item: gpuJob });
    ddbMock.on(QueryCommand, { IndexName: "GpuQueueIndex" }).resolves({
      Items: [waitingEntry("job-1", 0)],
    });
    ddbMock.on(QueryCommand, { TableName: REQUIRED_ENV.GPU_SLOTS_TABLE }).resolves({
      Items: [{ slotKey: "gpu", itemKey: "#quota", usedVcpu: 0 }],
    });
    ddbMock.on(TransactWriteCommand).resolves({});

    const { handler } = await import("./acquireGpuSlot.js");
    const result = await handler({ jobId: "job-1", attempt: 2 });

    expect(result.acquired).toBe(true);
    expect(result.timedOut).toBe(false);
    const transactInput = ddbMock.commandCalls(TransactWriteCommand)[0]?.args[0].input;
    expect(transactInput?.TransactItems?.[0]?.Put?.Item?.vcpu).toBe(8);
  });

  it("gpuQueuedAtは2回目以降の呼び出しでも変わらない(if_not_existsで1回だけセット)", async () => {
    ddbMock.on(GetCommand).resolves({ Item: gpuJob });
    ddbMock.on(QueryCommand, { IndexName: "GpuQueueIndex" }).resolves({
      Items: [waitingEntry("job-1", 0)],
    });
    ddbMock.on(QueryCommand, { TableName: REQUIRED_ENV.GPU_SLOTS_TABLE }).resolves({
      Items: [{ slotKey: "gpu", itemKey: "#quota", usedVcpu: 8 }],
    });

    const { handler } = await import("./acquireGpuSlot.js");
    await handler({ jobId: "job-1", attempt: 1 });

    const markCall = ddbMock
      .commandCalls(UpdateCommand)
      .find((call) => String(call.args[0].input.UpdateExpression).includes("gpuQueueState = :waiting"));
    expect(markCall?.args[0].input.UpdateExpression).toContain(
      "gpuQueuedAt = if_not_exists(gpuQueuedAt, :now)",
    );
  });

  it("待機の上限(120分)を超えたらfailedを書き待機列から外しtimedOut:trueを返す", async () => {
    ddbMock.on(GetCommand).resolves({ Item: gpuJob });
    const enteredAt = new Date(Date.now() - 121 * 60 * 1000).toISOString();
    ddbMock.on(UpdateCommand).resolves({ Attributes: { gpuQueueEnteredAt: enteredAt } });

    const { handler } = await import("./acquireGpuSlot.js");
    const result = await handler({ jobId: "job-1", attempt: 1 });

    expect(result).toEqual({ jobId: "job-1", attempt: 1, acquired: false, timedOut: true, waitSeconds: 0 });
    const failedUpdate = ddbMock
      .commandCalls(UpdateCommand)
      .find((call) => call.args[0].input.ExpressionAttributeValues?.[":ec"] === "gpu_queue_timeout");
    expect(failedUpdate).toBeDefined();
    const removeUpdate = ddbMock
      .commandCalls(UpdateCommand)
      .find((call) => String(call.args[0].input.UpdateExpression).includes("REMOVE gpuQueueState"));
    expect(removeUpdate).toBeDefined();
    // タイムアウト確定時はGpuQueueIndex/GpuSlotsTableへ問い合わせない。
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
  });

  it("stopRequestedAtがあるジョブは待機列に入れない(markGpuQueueWaitingの条件不成立)", async () => {
    ddbMock.on(GetCommand).resolves({ Item: gpuJob });
    ddbMock
      .on(UpdateCommand)
      .rejects(new ConditionalCheckFailedException({ message: "conditional", $metadata: {} }));

    const { handler } = await import("./acquireGpuSlot.js");
    const result = await handler({ jobId: "job-1", attempt: 1 });

    expect(result.acquired).toBe(false);
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
  });

  it("ジョブが見つからなければ例外を投げる", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    const { handler } = await import("./acquireGpuSlot.js");
    await expect(handler({ jobId: "missing", attempt: 1 })).rejects.toThrow(/ジョブが見つかりません/);
  });
});
