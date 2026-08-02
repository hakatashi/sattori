import { beforeEach, describe, expect, it } from "vitest";
import {
  DescribeExecutionCommand,
  ExecutionDoesNotExist,
  type ExecutionStatus,
  type HistoryEvent,
  SFNClient,
} from "@aws-sdk/client-sfn";
import { mockClient } from "aws-sdk-client-mock";
import { buildExecutionArn, getExecutionLiveness, toAdminExecutionEvent } from "./stepFunctions.js";

describe("buildExecutionArn", () => {
  it("ステートマシンARNの:stateMachine:部分を:execution:NAME:{jobId}に置き換える", () => {
    const arn = buildExecutionArn(
      "arn:aws:states:us-east-1:123456789012:stateMachine:SattoriStack-RecordingStateMachine",
      "job-1",
    );
    expect(arn).toBe(
      "arn:aws:states:us-east-1:123456789012:execution:SattoriStack-RecordingStateMachine:job-1",
    );
  });

  it("不正な形式のARNは例外を投げる", () => {
    expect(() => buildExecutionArn("not-an-arn", "job-1")).toThrow();
    expect(() =>
      buildExecutionArn("arn:aws:states:us-east-1:123456789012:activity:foo", "job-1"),
    ).toThrow();
  });
});

describe("getExecutionLiveness", () => {
  const sfnMock = mockClient(SFNClient);
  const sfn = new SFNClient({});
  const executionArn = "arn:aws:states:us-east-1:123456789012:execution:StateMachine:job-1";

  beforeEach(() => {
    sfnMock.reset();
  });

  it("RUNNINGならrunning", async () => {
    sfnMock.on(DescribeExecutionCommand).resolves({ status: "RUNNING" });
    await expect(getExecutionLiveness(sfn, executionArn)).resolves.toBe("running");
  });

  it("終了済みのstatusはfinished", async () => {
    const statuses: ExecutionStatus[] = ["SUCCEEDED", "FAILED", "TIMED_OUT", "ABORTED"];
    for (const status of statuses) {
      sfnMock.on(DescribeExecutionCommand).resolves({ status });
      await expect(getExecutionLiveness(sfn, executionArn)).resolves.toBe("finished");
    }
  });

  it("実行が存在しなければabsent", async () => {
    sfnMock
      .on(DescribeExecutionCommand)
      .rejects(new ExecutionDoesNotExist({ message: "does not exist", $metadata: {} }));
    await expect(getExecutionLiveness(sfn, executionArn)).resolves.toBe("absent");
  });

  it("それ以外の失敗はそのまま投げる(呼び出し側が安全側に倒せるようにするため)", async () => {
    sfnMock.on(DescribeExecutionCommand).rejects(new Error("throttled"));
    await expect(getExecutionLiveness(sfn, executionArn)).rejects.toThrow("throttled");
  });
});

describe("toAdminExecutionEvent", () => {
  it("id・previousEventId・type・timestampを詰め替える", () => {
    const event: HistoryEvent = {
      id: 3,
      previousEventId: 2,
      type: "TaskStateEntered",
      timestamp: new Date("2026-07-30T12:00:00.000Z"),
    };
    expect(toAdminExecutionEvent(event)).toEqual({
      id: 3,
      previousEventId: 2,
      type: "TaskStateEntered",
      timestamp: "2026-07-30T12:00:00.000Z",
      details: null,
    });
  });

  it("previousEventId: 0(先頭イベント)はnullに落とさずそのまま保持する", () => {
    const event: HistoryEvent = {
      id: 1,
      previousEventId: 0,
      type: "ExecutionStarted",
      timestamp: new Date("2026-07-30T12:00:00.000Z"),
    };
    expect(toAdminExecutionEvent(event).previousEventId).toBe(0);
  });

  it("非nullの*EventDetailsを抜き出してdetailsに入れる", () => {
    const event: HistoryEvent = {
      id: 5,
      previousEventId: 4,
      type: "ExecutionFailed",
      timestamp: new Date("2026-07-30T12:00:05.000Z"),
      executionFailedEventDetails: { error: "States.Timeout", cause: "録画がタイムアウトしました" },
    };
    expect(toAdminExecutionEvent(event).details).toEqual({
      error: "States.Timeout",
      cause: "録画がタイムアウトしました",
    });
  });

  it("timestampが無ければnull", () => {
    const event = { id: 1, type: "Unknown" } as unknown as HistoryEvent;
    expect(toAdminExecutionEvent(event).timestamp).toBeNull();
  });
});
