import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CloudWatchLogsClient,
  GetLogEventsCommand,
  ResourceNotFoundException,
} from "@aws-sdk/client-cloudwatch-logs";
import { EC2Client, GetConsoleOutputCommand } from "@aws-sdk/client-ec2";
import { mockClient } from "aws-sdk-client-mock";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import type { AdminLogsResponse } from "@sattori/shared";

const logsMock = mockClient(CloudWatchLogsClient);
const ec2Mock = mockClient(EC2Client);

function makeEvent(
  jobId: string,
  query?: Record<string, string>,
): APIGatewayProxyEventV2 {
  return {
    pathParameters: { jobId },
    queryStringParameters: query,
  } as unknown as APIGatewayProxyEventV2;
}

function parseBody(res: APIGatewayProxyStructuredResultV2): AdminLogsResponse {
  return JSON.parse(res.body ?? "{}") as AdminLogsResponse;
}

describe("GET /admin/jobs/{jobId}/logs", () => {
  beforeEach(() => {
    logsMock.reset();
    ec2Mock.reset();
    vi.stubEnv("WORKER_LOG_GROUP", "/sattori/worker");
  });

  it("ログストリーム(=jobId)のイベントを新しい方から取得して返す", async () => {
    logsMock.on(GetLogEventsCommand).resolves({
      events: [
        { timestamp: 1000, message: "start recording" },
        { timestamp: 2000, message: "recording done" },
      ],
      nextBackwardToken: "back-token-1",
      nextForwardToken: "fwd-token-1",
    });

    const { handler } = await import("./getLogs.js");
    const res = (await handler(
      makeEvent("job-1"),
      {} as never,
      () => {},
    )) as APIGatewayProxyStructuredResultV2;
    const body = parseBody(res);

    expect(res.statusCode).toBe(200);
    expect(body.logStreamFound).toBe(true);
    expect(body.events).toHaveLength(2);
    expect(body.events[0]?.message).toBe("start recording");
    expect(body.nextBackwardToken).toBe("back-token-1");
    expect(body.consoleOutput).toBeNull();

    const call = logsMock.commandCalls(GetLogEventsCommand)[0];
    expect(call?.args[0].input.logGroupName).toBe("/sattori/worker");
    expect(call?.args[0].input.logStreamName).toBe("job-1");
    expect(call?.args[0].input.startFromHead).toBe(false);
  });

  it("初回取得でGetLogEventsが空応答を返した場合、nextBackwardTokenを辿って実データを取得する", async () => {
    logsMock
      .on(GetLogEventsCommand)
      .resolvesOnce({
        events: [],
        nextBackwardToken: "back-token-boundary",
        nextForwardToken: "fwd-token-boundary",
      })
      .resolvesOnce({
        events: [{ timestamp: 1000, message: "start recording" }],
        nextBackwardToken: "back-token-1",
        nextForwardToken: "fwd-token-1",
      });

    const { handler } = await import("./getLogs.js");
    const res = (await handler(
      makeEvent("job-1"),
      {} as never,
      () => {},
    )) as APIGatewayProxyStructuredResultV2;
    const body = parseBody(res);

    expect(body.logStreamFound).toBe(true);
    expect(body.events).toHaveLength(1);
    expect(body.events[0]?.message).toBe("start recording");
    expect(body.nextBackwardToken).toBe("back-token-1");

    const calls = logsMock.commandCalls(GetLogEventsCommand);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.args[0].input.nextToken).toBeUndefined();
    expect(calls[1]?.args[0].input.nextToken).toBe("back-token-boundary");
  });

  it("空応答が続いてもトークンが前進しなくなれば打ち切って空のログとして返す", async () => {
    logsMock.on(GetLogEventsCommand).resolves({
      events: [],
      nextBackwardToken: "same-token",
    });

    const { handler } = await import("./getLogs.js");
    const res = (await handler(
      makeEvent("job-1", { cursor: "same-token" }),
      {} as never,
      () => {},
    )) as APIGatewayProxyStructuredResultV2;
    const body = parseBody(res);

    expect(body.events).toEqual([]);
    expect(body.nextBackwardToken).toBeNull();
    expect(logsMock.commandCalls(GetLogEventsCommand)).toHaveLength(1);
  });

  it("cursorを渡して古いイベントへページングできる", async () => {
    logsMock.on(GetLogEventsCommand).resolves({
      events: [{ timestamp: 500, message: "earlier line" }],
      nextBackwardToken: "back-token-2",
    });

    const { handler } = await import("./getLogs.js");
    const res = (await handler(
      makeEvent("job-1", { cursor: "back-token-1" }),
      {} as never,
      () => {},
    )) as APIGatewayProxyStructuredResultV2;
    const body = parseBody(res);

    expect(body.events).toHaveLength(1);
    expect(body.nextBackwardToken).toBe("back-token-2");

    const call = logsMock.commandCalls(GetLogEventsCommand)[0];
    expect(call?.args[0].input.nextToken).toBe("back-token-1");
  });

  it("これ以上古いイベントが無い場合はnextBackwardTokenをnullにする", async () => {
    logsMock.on(GetLogEventsCommand).resolves({
      events: [],
      nextBackwardToken: "back-token-1",
    });

    const { handler } = await import("./getLogs.js");
    const res = (await handler(
      makeEvent("job-1", { cursor: "back-token-1" }),
      {} as never,
      () => {},
    )) as APIGatewayProxyStructuredResultV2;
    const body = parseBody(res);

    expect(body.events).toEqual([]);
    expect(body.nextBackwardToken).toBeNull();
  });

  it("ログストリームが無い場合、instanceId指定時はコンソール出力にフォールバックする", async () => {
    logsMock
      .on(GetLogEventsCommand)
      .rejects(
        new ResourceNotFoundException({ message: "The specified log stream does not exist.", $metadata: {} }),
      );
    ec2Mock.on(GetConsoleOutputCommand).resolves({
      Output: Buffer.from("boot failed: ECR login error", "utf-8").toString("base64"),
    });

    const { handler } = await import("./getLogs.js");
    const res = (await handler(
      makeEvent("job-2", { instanceId: "i-0123456789abcdef0" }),
      {} as never,
      () => {},
    )) as APIGatewayProxyStructuredResultV2;
    const body = parseBody(res);

    expect(res.statusCode).toBe(200);
    expect(body.logStreamFound).toBe(false);
    expect(body.events).toEqual([]);
    expect(body.consoleOutput).toBe("boot failed: ECR login error");

    const call = ec2Mock.commandCalls(GetConsoleOutputCommand)[0];
    expect(call?.args[0].input.InstanceId).toBe("i-0123456789abcdef0");
  });

  it("ログストリームが無くinstanceId未指定の場合はconsoleOutputもnull", async () => {
    logsMock
      .on(GetLogEventsCommand)
      .rejects(
        new ResourceNotFoundException({ message: "The specified log stream does not exist.", $metadata: {} }),
      );

    const { handler } = await import("./getLogs.js");
    const res = (await handler(
      makeEvent("job-3"),
      {} as never,
      () => {},
    )) as APIGatewayProxyStructuredResultV2;
    const body = parseBody(res);

    expect(body.logStreamFound).toBe(false);
    expect(body.consoleOutput).toBeNull();
    expect(ec2Mock.commandCalls(GetConsoleOutputCommand)).toHaveLength(0);
  });

  it("jobIdが無ければ400を返す", async () => {
    const { handler } = await import("./getLogs.js");
    const res = (await handler(
      { pathParameters: {} } as unknown as APIGatewayProxyEventV2,
      {} as never,
      () => {},
    )) as APIGatewayProxyStructuredResultV2;
    expect(res.statusCode).toBe(400);
  });
});
