import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import { mockClient } from "aws-sdk-client-mock";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import type { JobRecord } from "@sattori/shared";

const REQUIRED_ENV: Record<string, string> = {
  UPLOAD_BUCKET: "up-bucket",
  OUTPUT_BUCKET: "out-bucket",
  CDN_DOMAIN: "cdn.example.net",
  JOBS_TABLE: "sattori-jobs",
  WORKER_IMAGE: "123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/sattori-worker:latest",
  TITLE_ASSETS_BUCKET: "title-assets-bucket",
  WORKER_LOG_GROUP: "/sattori/worker",
  WORKER_SUBNET_IDS: "subnet-xxxx,subnet-yyyy",
  WORKER_LAUNCH_TEMPLATE_ID: "lt-xxxx",
  EMAIL_RATE_LIMIT_TABLE: "email-rate-limit",
  SES_FROM_ADDRESS: "no-reply@sattori.hakatashi.com",
  WEB_BASE_URL: "https://sattori.hakatashi.com",
  STATE_MACHINE_ARN: "arn:aws:states:us-east-1:123456789012:stateMachine:RecordingStateMachine",
};

const ddbMock = mockClient(DynamoDBDocumentClient);
const sfnMock = mockClient(SFNClient);

const pendingJob: JobRecord = {
  jobId: "job-1",
  game: "th07",
  replayKey: "replays/abc.rpy",
  status: "pending",
  options: { watermark: true },
  outputPath: null,
  outputPath720p: null,
  error: null,
  createdAt: "2026-07-18T00:00:00.000Z",
  updatedAt: "2026-07-18T00:00:00.000Z",
  email: "user@example.com",
  instanceId: null,
  estimatedDurationSeconds: 900,
  progress: null,
  previewImagePath: null,
  replayInfo: null,
  pendingExpiresAt: "2099-01-01T00:00:00.000Z",
};

function makeEvent(jobId: string): APIGatewayProxyEventV2 {
  return { pathParameters: { jobId } } as unknown as APIGatewayProxyEventV2;
}

function parseBody(res: APIGatewayProxyStructuredResultV2): unknown {
  return JSON.parse(res.body ?? "{}");
}

describe("POST /jobs/{jobId}/start", () => {
  beforeEach(() => {
    vi.resetModules();
    ddbMock.reset();
    sfnMock.reset();
    for (const [key, value] of Object.entries(REQUIRED_ENV)) {
      vi.stubEnv(key, value);
    }
  });

  it("pendingジョブなら起動してqueuedを返す", async () => {
    ddbMock.on(GetCommand).resolves({ Item: pendingJob });
    ddbMock.on(UpdateCommand).resolves({});
    sfnMock.on(StartExecutionCommand).resolves({ executionArn: "arn:exec", startDate: new Date() });

    const { handler } = await import("./startJob.js");
    const res = await handler(makeEvent("job-1"), {} as never, () => {});
    const result = res as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(200);
    expect(parseBody(result)).toEqual({ jobId: "job-1", status: "queued" });

    const updateCall = ddbMock.commandCalls(UpdateCommand)[0];
    expect(updateCall?.args[0].input.ConditionExpression).toBe("#s = :pending");
    expect(updateCall?.args[0].input.ReturnValuesOnConditionCheckFailure).toBe("ALL_OLD");
    expect(sfnMock.commandCalls(StartExecutionCommand)).toHaveLength(1);
  });

  it("ジョブが存在しなければ404を返す", async () => {
    ddbMock.on(GetCommand).resolves({});
    const { handler } = await import("./startJob.js");
    const res = await handler(makeEvent("missing"), {} as never, () => {});
    expect((res as APIGatewayProxyStructuredResultV2).statusCode).toBe(404);
  });

  it("既にqueued以降なら再起動せず現在の状態を返す(冪等)", async () => {
    ddbMock.on(GetCommand).resolves({ Item: { ...pendingJob, status: "recording" } });
    const { handler } = await import("./startJob.js");
    const res = await handler(makeEvent("job-1"), {} as never, () => {});
    const result = res as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(200);
    expect(parseBody(result)).toEqual({ jobId: "job-1", status: "recording" });
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
    expect(sfnMock.commandCalls(StartExecutionCommand)).toHaveLength(0);
  });

  it("受付期限切れのpendingジョブは410を返す", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { ...pendingJob, pendingExpiresAt: "2000-01-01T00:00:00.000Z" },
    });
    const { handler } = await import("./startJob.js");
    const res = await handler(makeEvent("job-1"), {} as never, () => {});
    const result = res as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(410);
    expect(parseBody(result)).toMatchObject({ code: "job_expired" });
    expect(sfnMock.commandCalls(StartExecutionCommand)).toHaveLength(0);
  });

  it("並行リクエストで既に起動済みになっていれば、再起動せず最新状態を返す", async () => {
    ddbMock.on(GetCommand).resolvesOnce({ Item: pendingJob });
    ddbMock.on(UpdateCommand).rejects(
      new ConditionalCheckFailedException({
        message: "failed",
        $metadata: {},
        Item: marshall({ ...pendingJob, status: "queued" }),
      }),
    );

    const { handler } = await import("./startJob.js");
    const res = await handler(makeEvent("job-1"), {} as never, () => {});
    const result = res as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(200);
    expect(parseBody(result)).toEqual({ jobId: "job-1", status: "queued" });
    expect(sfnMock.commandCalls(StartExecutionCommand)).toHaveLength(0);
    // ReturnValuesOnConditionCheckFailureで取得した既存itemを使うため、
    // 追加のGetItem往復は発生しない(最初の1回のみ)。
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(1);
  });

  it("StartExecution失敗時はジョブをfailedにし502を返す", async () => {
    ddbMock.on(GetCommand).resolves({ Item: pendingJob });
    ddbMock.on(UpdateCommand).resolves({});
    sfnMock.on(StartExecutionCommand).rejects(new Error("boom"));

    const { handler } = await import("./startJob.js");
    const res = await handler(makeEvent("job-1"), {} as never, () => {});
    const result = res as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(502);
    const failedUpdate = ddbMock
      .commandCalls(UpdateCommand)
      .find((call) => call.args[0].input.ExpressionAttributeValues?.[":s"] === "failed");
    expect(failedUpdate).toBeTruthy();
  });
});
