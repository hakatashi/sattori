import { beforeEach, describe, expect, it, vi } from "vitest";
import { DescribeInstancesCommand, EC2Client, TerminateInstancesCommand } from "@aws-sdk/client-ec2";
import { DescribeExecutionCommand, SFNClient } from "@aws-sdk/client-sfn";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";

const REQUIRED_ENV: Record<string, string> = {
  JOBS_TABLE: "sattori-jobs",
  STATE_MACHINE_ARN: "arn:aws:states:eu-south-2:123456789012:stateMachine:RecordingStateMachine",
};

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
});

describe("sweepOrphanInstances handler", () => {
  it("実行が終わっているジョブのインスタンスをterminateする", async () => {
    ec2Mock.on(DescribeInstancesCommand).resolves({
      Reservations: [{ Instances: [taggedInstance("i-orphan", "job-1")] }],
    });
    sfnMock.on(DescribeExecutionCommand).resolves({ status: "FAILED" });

    const { handler } = await import("./sweepOrphanInstances.js");
    const result = await handler();

    expect(result).toEqual({ scanned: 1, orphans: 1, terminated: 1, skippedJobs: 0 });
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

    expect(result).toEqual({ scanned: 1, orphans: 0, terminated: 0, skippedJobs: 1 });
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

    expect(result).toEqual({ scanned: 2, orphans: 2, terminated: 1, skippedJobs: 0 });
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

    expect(result).toEqual({ scanned: 1, orphans: 0, terminated: 0, skippedJobs: 1 });
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

    expect(result).toEqual({ scanned: 0, orphans: 0, terminated: 0, skippedJobs: 0 });
    expect(sfnMock.commandCalls(DescribeExecutionCommand)).toHaveLength(0);
  });
});
