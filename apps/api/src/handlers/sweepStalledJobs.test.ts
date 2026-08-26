import { beforeEach, describe, expect, it, vi } from "vitest";
import { DescribeExecutionCommand, SFNClient } from "@aws-sdk/client-sfn";
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";

const REQUIRED_ENV: Record<string, string> = {
  JOBS_TABLE: "sattori-jobs",
  STATE_MACHINE_ARN: "arn:aws:states:eu-south-2:123456789012:stateMachine:RecordingStateMachine",
};

const sfnMock = mockClient(SFNClient);
const ddbMock = mockClient(DynamoDBDocumentClient);

/** 掃除対象になる程度に古い(猶予180分より前の)更新時刻。 */
const OLD_UPDATED_AT = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
const RECENT_UPDATED_AT = new Date(Date.now() - 5 * 60 * 1000).toISOString();

function jobRecord(jobId: string, status: string, updatedAt: string) {
  return { jobId, status, updatedAt, createdAt: updatedAt };
}

beforeEach(() => {
  for (const [key, value] of Object.entries(REQUIRED_ENV)) {
    vi.stubEnv(key, value);
  }
  sfnMock.reset();
  ddbMock.reset();
  ddbMock.on(QueryCommand).resolves({ Items: [] });
  ddbMock.on(UpdateCommand).resolves({});
});

describe("sweepStalledJobs handler", () => {
  it("実行が生きていない古いジョブをfailedへ倒す", async () => {
    ddbMock
      .on(QueryCommand, { ExpressionAttributeValues: { ":status": "recording" } })
      .resolves({ Items: [jobRecord("job-1", "recording", OLD_UPDATED_AT)] });
    sfnMock.on(DescribeExecutionCommand).resolves({ status: "FAILED" });

    const { handler } = await import("./sweepStalledJobs.js");
    const result = await handler();

    expect(result).toEqual({ scanned: 1, stalled: 1, failed: 1, skippedJobs: 0 });
    const updateCall = ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input;
    expect(updateCall?.Key).toEqual({ jobId: "job-1" });
    expect(updateCall?.ExpressionAttributeValues?.[":s"]).toBe("failed");
    expect(updateCall?.ExpressionAttributeValues?.[":ec"]).toBe("stalled");
  });

  it("実行が生きているジョブはupdatedAtがどれだけ古くても対象外", async () => {
    ddbMock
      .on(QueryCommand, { ExpressionAttributeValues: { ":status": "recording" } })
      .resolves({ Items: [jobRecord("job-1", "recording", OLD_UPDATED_AT)] });
    sfnMock.on(DescribeExecutionCommand).resolves({ status: "RUNNING" });

    const { handler } = await import("./sweepStalledJobs.js");
    const result = await handler();

    expect(result).toEqual({ scanned: 1, stalled: 0, failed: 0, skippedJobs: 0 });
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it("まだ猶予内の新しいジョブは対象外", async () => {
    ddbMock
      .on(QueryCommand, { ExpressionAttributeValues: { ":status": "queued" } })
      .resolves({ Items: [jobRecord("job-1", "queued", RECENT_UPDATED_AT)] });
    sfnMock.on(DescribeExecutionCommand).resolves({ status: "ABORTED" });

    const { handler } = await import("./sweepStalledJobs.js");
    const result = await handler();

    expect(result).toEqual({ scanned: 1, stalled: 0, failed: 0, skippedJobs: 0 });
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it("DescribeExecutionに失敗したジョブは見送る", async () => {
    ddbMock
      .on(QueryCommand, { ExpressionAttributeValues: { ":status": "launching" } })
      .resolves({ Items: [jobRecord("job-1", "launching", OLD_UPDATED_AT)] });
    sfnMock.on(DescribeExecutionCommand).rejects(new Error("throttled"));

    const { handler } = await import("./sweepStalledJobs.js");
    const result = await handler();

    expect(result).toEqual({ scanned: 1, stalled: 0, failed: 0, skippedJobs: 1 });
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it("あるジョブの更新が失敗しても他のジョブの掃除は続ける", async () => {
    ddbMock
      .on(QueryCommand, { ExpressionAttributeValues: { ":status": "converting" } })
      .resolves({
        Items: [jobRecord("job-fail", "converting", OLD_UPDATED_AT)],
      });
    ddbMock
      .on(QueryCommand, { ExpressionAttributeValues: { ":status": "recording" } })
      .resolves({ Items: [jobRecord("job-ok", "recording", OLD_UPDATED_AT)] });
    sfnMock.on(DescribeExecutionCommand).resolves({ status: "TIMED_OUT" });
    ddbMock.on(UpdateCommand, { Key: { jobId: "job-fail" } }).rejects(new Error("throttled"));

    const { handler } = await import("./sweepStalledJobs.js");
    const result = await handler();

    expect(result).toEqual({ scanned: 2, stalled: 2, failed: 1, skippedJobs: 0 });
  });

  it("QueryCommand自体が失敗したら例外を投げる", async () => {
    ddbMock.on(QueryCommand).rejects(new Error("ProvisionedThroughputExceededException"));

    const { handler } = await import("./sweepStalledJobs.js");
    await expect(handler()).rejects.toThrow("ProvisionedThroughputExceededException");
  });

  it("pendingは問い合わせ対象に含まない", async () => {
    const { handler } = await import("./sweepStalledJobs.js");
    await handler();

    const queriedStatuses = ddbMock
      .commandCalls(QueryCommand)
      .map((call) => call.args[0].input.ExpressionAttributeValues?.[":status"]);
    expect(queriedStatuses.sort()).toEqual(["converting", "launching", "queued", "recording"]);
  });
});
