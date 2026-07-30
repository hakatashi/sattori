import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DescribeExecutionCommand,
  ExecutionDoesNotExist,
  GetExecutionHistoryCommand,
  SFNClient,
} from "@aws-sdk/client-sfn";
import { mockClient } from "aws-sdk-client-mock";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import type { AdminExecutionResponse } from "@sattori/shared";

const sfnMock = mockClient(SFNClient);

const STATE_MACHINE_ARN =
  "arn:aws:states:us-east-1:123456789012:stateMachine:SattoriStack-RecordingStateMachine";

function makeEvent(jobId: string): APIGatewayProxyEventV2 {
  return { pathParameters: { jobId } } as unknown as APIGatewayProxyEventV2;
}

function parseBody(res: APIGatewayProxyStructuredResultV2): AdminExecutionResponse {
  return JSON.parse(res.body ?? "{}") as AdminExecutionResponse;
}

describe("GET /admin/jobs/{jobId}/execution", () => {
  beforeEach(() => {
    sfnMock.reset();
    vi.stubEnv("STATE_MACHINE_ARN", STATE_MACHINE_ARN);
  });

  it("実行ARNをjobIdから導出し、実行状態と履歴イベントを返す", async () => {
    sfnMock.on(DescribeExecutionCommand).resolves({
      executionArn: `${STATE_MACHINE_ARN.replace(":stateMachine:", ":execution:")}:job-1`,
      stateMachineArn: STATE_MACHINE_ARN,
      status: "RUNNING",
      startDate: new Date("2026-07-30T00:00:00.000Z"),
    });
    sfnMock.on(GetExecutionHistoryCommand).resolves({
      events: [
        {
          id: 1,
          previousEventId: 0,
          type: "ExecutionStarted",
          timestamp: new Date("2026-07-30T00:00:00.000Z"),
        },
      ],
    });

    const { handler } = await import("./getExecution.js");
    const res = await handler(makeEvent("job-1"), {} as never, () => {});
    const body = parseBody(res as APIGatewayProxyStructuredResultV2);

    expect(body.execution?.executionArn).toBe(
      "arn:aws:states:us-east-1:123456789012:execution:SattoriStack-RecordingStateMachine:job-1",
    );
    expect(body.execution?.status).toBe("RUNNING");
    expect(body.events).toHaveLength(1);
    expect(body.events[0]?.type).toBe("ExecutionStarted");

    const describeCall = sfnMock.commandCalls(DescribeExecutionCommand)[0];
    expect(describeCall?.args[0].input.executionArn).toBe(
      "arn:aws:states:us-east-1:123456789012:execution:SattoriStack-RecordingStateMachine:job-1",
    );
  });

  it("実行が存在しない場合はExecutionDoesNotExistを捕捉し200 + execution:nullを返す", async () => {
    sfnMock.on(DescribeExecutionCommand).rejects(
      new ExecutionDoesNotExist({ message: "Execution Does Not Exist", $metadata: {} }),
    );
    sfnMock.on(GetExecutionHistoryCommand).rejects(
      new ExecutionDoesNotExist({ message: "Execution Does Not Exist", $metadata: {} }),
    );

    const { handler } = await import("./getExecution.js");
    const res = await handler(makeEvent("pending-job"), {} as never, () => {});
    const body = parseBody(res as APIGatewayProxyStructuredResultV2);

    expect((res as APIGatewayProxyStructuredResultV2).statusCode).toBe(200);
    expect(body.execution).toBeNull();
    expect(body.events).toEqual([]);
  });

  it("jobIdが無ければ400を返す", async () => {
    const { handler } = await import("./getExecution.js");
    const res = (await handler(
      { pathParameters: {} } as unknown as APIGatewayProxyEventV2,
      {} as never,
      () => {},
    )) as APIGatewayProxyStructuredResultV2;
    expect(res.statusCode).toBe(400);
  });
});
