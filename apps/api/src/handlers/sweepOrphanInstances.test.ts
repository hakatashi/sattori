import { beforeEach, describe, expect, it, vi } from "vitest";
import { DescribeInstancesCommand, EC2Client, TerminateInstancesCommand } from "@aws-sdk/client-ec2";
import { DescribeExecutionCommand, SFNClient } from "@aws-sdk/client-sfn";
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";

const REQUIRED_ENV: Record<string, string> = {
  JOBS_TABLE: "sattori-jobs",
  STATE_MACHINE_ARN: "arn:aws:states:eu-south-2:123456789012:stateMachine:RecordingStateMachine",
  GPU_SLOTS_TABLE: "sattori-gpu-slots",
};

/** GPUリース回収の期待値(このPRの対象範囲外のテストでは常に0件)。 */
const NO_GPU_RECONCILE = { leasesReclaimed: 0, leasesRepaired: 0, leasesCompensated: 0, staleQueueEntriesCleared: 0 };

const ec2Mock = mockClient(EC2Client);
const sfnMock = mockClient(SFNClient);
const ddbMock = mockClient(DynamoDBDocumentClient);

/** 掃除対象になる程度に古い（猶予15分より前の）起動時刻。 */
const OLD_LAUNCH_TIME = new Date(Date.now() - 60 * 60 * 1000);

function taggedInstance(instanceId: string, jobId: string, launchTime = OLD_LAUNCH_TIME) {
  return {
    InstanceId: instanceId,
    LaunchTime: launchTime,
    Tags: [{ Key: "sattori:jobId", Value: jobId }],
  };
}

/** `TerminateInstances` に渡されたインスタンスIDを呼び出し順に並べる。 */
function terminatedIds(): string[] {
  return ec2Mock
    .commandCalls(TerminateInstancesCommand)
    .flatMap((call) => call.args[0].input.InstanceIds ?? []);
}

beforeEach(() => {
  for (const [key, value] of Object.entries(REQUIRED_ENV)) {
    vi.stubEnv(key, value);
  }
  ec2Mock.reset();
  sfnMock.reset();
  ddbMock.reset();
  ec2Mock.on(TerminateInstancesCommand).resolves({});
  ddbMock.on(GetCommand).resolves({ Item: undefined });
  // GPUリース台帳(GpuSlotsTable)は既定で空。GPUリコンサイラの判定ロジック自体は
  // gpuReconcile.test.ts、DynamoDB操作の単体は gpuSlots.test.ts で検証する。
  // ここでは「掃除ハンドラが正しく繋ぎ込んでいるか」だけをE2Eで確認する。
  ddbMock.on(QueryCommand).resolves({ Items: [] });
  // 待機列(GpuQueueIndex)のQueryは、各テストが汎用マッチャ(`.on(QueryCommand)`)で
  // GpuSlotsTable向けの応答を上書きしても引きずられないよう、IndexNameで
  // 明示的に区別する（aws-sdk-client-mockは指定条件が具体的なスタブを優先する）。
  ddbMock.on(QueryCommand, { IndexName: "GpuQueueIndex" }).resolves({ Items: [] });
  ddbMock.on(TransactWriteCommand).resolves({});
});

/** GPUリース回収テスト用の猶予超過な起動時刻。 */
const OLD_GPU_LEASE_ACQUIRED_AT = new Date(Date.now() - 30 * 60 * 1000).toISOString();

function gpuQuotaItem(usedVcpu: number) {
  return { slotKey: "gpu", itemKey: "#quota", usedVcpu };
}

function gpuLeaseItem(jobId: string, vcpu: number, acquiredAt = OLD_GPU_LEASE_ACQUIRED_AT) {
  return {
    slotKey: "gpu",
    itemKey: `job#${jobId}`,
    jobId,
    vcpu,
    acquiredAt,
    expiresAt: new Date(Date.now() + 160 * 60 * 1000).toISOString(),
    expectedFinishAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  };
}

describe("sweepOrphanInstances handler（GPU vCPU容量リースのリコンサイラ、Issue #270）", () => {
  it("生存GPUインスタンスが無く実行も終わったリースを回収する", async () => {
    ec2Mock.on(DescribeInstancesCommand).resolves({});
    ddbMock
      .on(QueryCommand)
      .resolves({ Items: [gpuQuotaItem(4), gpuLeaseItem("gpu-job-1", 4)] });
    // releaseGpuSlot()内部のGetCommand(存在確認)。QueryCommandの結果と整合させる。
    ddbMock.on(GetCommand).resolves({ Item: gpuLeaseItem("gpu-job-1", 4) });
    sfnMock.on(DescribeExecutionCommand).resolves({ status: "FAILED" });

    const { handler } = await import("./sweepOrphanInstances.js");
    const result = await handler();

    expect(result).toMatchObject({ leasesReclaimed: 1, leasesRepaired: 0, leasesCompensated: 0 });
    // releaseGpuSlot()はGetCommandでリースを確認してからTransactWriteCommandを発行する。
    expect(ddbMock.commandCalls(TransactWriteCommand).length).toBeGreaterThan(0);
  });

  it("実行が生きているリースは回収しない(起動直前の可能性があるため)", async () => {
    ec2Mock.on(DescribeInstancesCommand).resolves({});
    ddbMock
      .on(QueryCommand)
      .resolves({ Items: [gpuQuotaItem(4), gpuLeaseItem("gpu-job-1", 4)] });
    sfnMock.on(DescribeExecutionCommand).resolves({ status: "RUNNING" });

    const { handler } = await import("./sweepOrphanInstances.js");
    const result = await handler();

    expect(result).toMatchObject({ leasesReclaimed: 0 });
  });

  it("実測vCPUとリースが食い違うものを補正する", async () => {
    ec2Mock.on(DescribeInstancesCommand).resolves({
      Reservations: [
        {
          Instances: [
            {
              InstanceId: "i-gpu",
              LaunchTime: OLD_LAUNCH_TIME,
              InstanceType: "g6f.xlarge",
              Tags: [{ Key: "sattori:jobId", Value: "gpu-job-1" }],
            },
          ],
        },
      ],
    });
    // リースは8vCPU(仮予約のまま)だが実際に確保できたのはg6f.xlarge(4vCPU)
    // = shrinkGpuLease失敗を想定したドリフト。
    ddbMock.on(QueryCommand).resolves({ Items: [gpuQuotaItem(8), gpuLeaseItem("gpu-job-1", 8)] });
    sfnMock.on(DescribeExecutionCommand).resolves({ status: "RUNNING" });

    const { handler } = await import("./sweepOrphanInstances.js");
    const result = await handler();

    expect(result).toMatchObject({ leasesRepaired: 1, leasesReclaimed: 0 });
  });

  it("リースの無い生存GPUインスタンスに補完リースを作成する", async () => {
    ec2Mock.on(DescribeInstancesCommand).resolves({
      Reservations: [
        {
          Instances: [
            {
              InstanceId: "i-gpu",
              LaunchTime: OLD_LAUNCH_TIME,
              InstanceType: "g6f.2xlarge",
              Tags: [{ Key: "sattori:jobId", Value: "gpu-job-2" }],
            },
          ],
        },
      ],
    });
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    sfnMock.on(DescribeExecutionCommand).resolves({ status: "RUNNING" });

    const { handler } = await import("./sweepOrphanInstances.js");
    const result = await handler();

    expect(result).toMatchObject({ leasesCompensated: 1 });
  });

  it("CPU系インスタンスはGPUリコンサイラの対象にならない", async () => {
    ec2Mock.on(DescribeInstancesCommand).resolves({
      Reservations: [{ Instances: [taggedInstance("i-cpu", "job-1")] }],
    });
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    sfnMock.on(DescribeExecutionCommand).resolves({ status: "FAILED" });

    const { handler } = await import("./sweepOrphanInstances.js");
    const result = await handler();

    expect(result).toMatchObject(NO_GPU_RECONCILE);
  });

  it("GPUリース台帳の列挙に失敗しても孤児インスタンス掃除は続行する", async () => {
    ec2Mock.on(DescribeInstancesCommand).resolves({
      Reservations: [{ Instances: [taggedInstance("i-orphan", "job-1")] }],
    });
    ddbMock.on(QueryCommand).rejects(new Error("throttled"));
    sfnMock.on(DescribeExecutionCommand).resolves({ status: "FAILED" });

    const { handler } = await import("./sweepOrphanInstances.js");
    const result = await handler();

    expect(result).toMatchObject({ terminated: 1, ...NO_GPU_RECONCILE });
  });

  it("実行の生死問い合わせは孤児インスタンス掃除とGPUリコンサイラで共有(重複呼び出しを避ける)", async () => {
    ec2Mock.on(DescribeInstancesCommand).resolves({
      Reservations: [{ Instances: [taggedInstance("i-orphan", "gpu-job-1")] }],
    });
    ddbMock
      .on(QueryCommand)
      .resolves({ Items: [gpuQuotaItem(4), gpuLeaseItem("gpu-job-1", 4)] });
    sfnMock.on(DescribeExecutionCommand).resolves({ status: "FAILED" });

    const { handler } = await import("./sweepOrphanInstances.js");
    await handler();

    // 同一jobId("gpu-job-1")に対するDescribeExecutionは1回だけ
    // (孤児インスタンス掃除ループとGPUリース回収ループがキャッシュを共有する)。
    const calls = sfnMock
      .commandCalls(DescribeExecutionCommand)
      .filter((call) => call.args[0].input.executionArn?.endsWith(":gpu-job-1"));
    expect(calls).toHaveLength(1);
  });
});

describe("sweepOrphanInstances handler", () => {
  it("実行が終わっているジョブのインスタンスをterminateする", async () => {
    ec2Mock.on(DescribeInstancesCommand).resolves({
      Reservations: [{ Instances: [taggedInstance("i-orphan", "job-1")] }],
    });
    sfnMock.on(DescribeExecutionCommand).resolves({ status: "FAILED" });

    const { handler } = await import("./sweepOrphanInstances.js");
    const result = await handler();

    expect(result).toEqual({ scanned: 1, orphans: 1, terminated: 1, skippedJobs: 0, ...NO_GPU_RECONCILE });
    expect(terminatedIds()).toEqual(["i-orphan"]);
    // 実行の生死はjobIdから決定的に導ける実行ARNへ問い合わせる（executionArnはDBに持たない）。
    expect(sfnMock.commandCalls(DescribeExecutionCommand)[0]?.args[0].input.executionArn).toBe(
      "arn:aws:states:eu-south-2:123456789012:execution:RecordingStateMachine:job-1",
    );
  });

  it("実行が生きているジョブの最新インスタンスは残す", async () => {
    ec2Mock.on(DescribeInstancesCommand).resolves({
      Reservations: [
        {
          Instances: [
            taggedInstance("i-stale", "job-1", new Date(Date.now() - 120 * 60 * 1000)),
            taggedInstance("i-current", "job-1", new Date(Date.now() - 30 * 60 * 1000)),
          ],
        },
      ],
    });
    sfnMock.on(DescribeExecutionCommand).resolves({ status: "RUNNING" });

    const { handler } = await import("./sweepOrphanInstances.js");
    const result = await handler();

    expect(result).toMatchObject({ scanned: 2, orphans: 1, terminated: 1 });
    expect(terminatedIds()).toEqual(["i-stale"]);
  });

  it("DescribeExecutionに失敗したジョブは丸ごと見送る（判定できないものはterminateしない）", async () => {
    ec2Mock.on(DescribeInstancesCommand).resolves({
      Reservations: [{ Instances: [taggedInstance("i-unknown", "job-1")] }],
    });
    sfnMock.on(DescribeExecutionCommand).rejects(new Error("throttled"));

    const { handler } = await import("./sweepOrphanInstances.js");
    const result = await handler();

    expect(result).toEqual({ scanned: 1, orphans: 0, terminated: 0, skippedJobs: 1, ...NO_GPU_RECONCILE });
    expect(terminatedIds()).toEqual([]);
  });

  it("あるジョブのterminateが失敗しても他のジョブの掃除は続ける", async () => {
    ec2Mock.on(DescribeInstancesCommand).resolves({
      Reservations: [
        { Instances: [taggedInstance("i-fail", "job-1"), taggedInstance("i-ok", "job-2")] },
      ],
    });
    sfnMock.on(DescribeExecutionCommand).resolves({ status: "SUCCEEDED" });
    ec2Mock
      .on(TerminateInstancesCommand, { InstanceIds: ["i-fail"] })
      .rejects(new Error("RequestLimitExceeded"));

    const { handler } = await import("./sweepOrphanInstances.js");
    const result = await handler();

    expect(result).toEqual({ scanned: 2, orphans: 2, terminated: 1, skippedJobs: 0, ...NO_GPU_RECONCILE });
    expect(terminatedIds()).toEqual(["i-fail", "i-ok"]);
  });

  it("緊急停止が要求されたジョブは実行が生きていても全台terminateする", async () => {
    ec2Mock.on(DescribeInstancesCommand).resolves({
      Reservations: [{ Instances: [taggedInstance("i-stopped", "job-1")] }],
    });
    sfnMock.on(DescribeExecutionCommand).resolves({ status: "RUNNING" });
    ddbMock.on(GetCommand).resolves({
      Item: { jobId: "job-1", stopRequestedAt: "2026-08-14T11:00:00.000Z" },
    });

    const { handler } = await import("./sweepOrphanInstances.js");
    const result = await handler();

    expect(result).toMatchObject({ orphans: 1, terminated: 1 });
    expect(terminatedIds()).toEqual(["i-stopped"]);
  });

  it("ジョブレコードの取得に失敗したジョブは見送る", async () => {
    ec2Mock.on(DescribeInstancesCommand).resolves({
      Reservations: [{ Instances: [taggedInstance("i-aaa", "job-1")] }],
    });
    sfnMock.on(DescribeExecutionCommand).resolves({ status: "FAILED" });
    ddbMock.on(GetCommand).rejects(new Error("throttled"));

    const { handler } = await import("./sweepOrphanInstances.js");
    const result = await handler();

    expect(result).toEqual({ scanned: 1, orphans: 0, terminated: 0, skippedJobs: 1, ...NO_GPU_RECONCILE });
    expect(terminatedIds()).toEqual([]);
  });

  it("インスタンスの列挙自体に失敗したら例外を投げる（何もしていない実行を成功に見せない）", async () => {
    ec2Mock.on(DescribeInstancesCommand).rejects(new Error("UnauthorizedOperation"));

    const { handler } = await import("./sweepOrphanInstances.js");
    await expect(handler()).rejects.toThrow("UnauthorizedOperation");
  });

  it("対象インスタンスが無ければ何も呼ばない", async () => {
    ec2Mock.on(DescribeInstancesCommand).resolves({});

    const { handler } = await import("./sweepOrphanInstances.js");
    const result = await handler();

    expect(result).toEqual({ scanned: 0, orphans: 0, terminated: 0, skippedJobs: 0, ...NO_GPU_RECONCILE });
    expect(sfnMock.commandCalls(DescribeExecutionCommand)).toHaveLength(0);
  });
});
