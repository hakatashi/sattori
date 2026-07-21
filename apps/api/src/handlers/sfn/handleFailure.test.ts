import { beforeEach, describe, expect, it, vi } from "vitest";
import { EC2Client, TerminateInstancesCommand } from "@aws-sdk/client-ec2";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import type { JobRecord } from "@sattori/shared";
import { MAX_ATTEMPTS } from "../../retryPolicy.js";

const REQUIRED_ENV: Record<string, string> = {
  UPLOAD_BUCKET: "up-bucket",
  OUTPUT_BUCKET: "out-bucket",
  CDN_DOMAIN: "cdn.example.net",
  JOBS_TABLE: "sattori-jobs",
  WORKER_IMAGE: "123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/sattori-worker:latest",
  TITLE_ASSETS_BUCKET: "title-assets-bucket",
  WORKER_LOG_GROUP: "/sattori/worker",
  WORKER_SUBNET_IDS: "subnet-aaaa,subnet-bbbb",
  WORKER_LAUNCH_TEMPLATE_ID: "lt-xxxx",
  EMAIL_RATE_LIMIT_TABLE: "email-rate-limit",
  SES_FROM_ADDRESS: "no-reply@sattori.hakatashi.com",
  WEB_BASE_URL: "https://sattori.hakatashi.com",
};

const ec2Mock = mockClient(EC2Client);
const ddbMock = mockClient(DynamoDBDocumentClient);

const baseJob: JobRecord = {
  jobId: "job-1",
  game: "th07",
  replayKey: "replays/abc.rpy",
  status: "launching",
  options: { watermark: true },
  outputPath: null,
  outputPath720p: null,
  error: null,
  createdAt: "2026-07-17T00:00:00.000Z",
  updatedAt: "2026-07-17T00:00:00.000Z",
  email: null,
  instanceId: "i-abc123",
  estimatedDurationSeconds: null,
  progress: null,
  previewImagePath: null,
  pendingExpiresAt: null,
};

beforeEach(() => {
  for (const [key, value] of Object.entries(REQUIRED_ENV)) {
    vi.stubEnv(key, value);
  }
  ec2Mock.reset();
  ddbMock.reset();
});

describe("sfn/handleFailure handler", () => {
  it("インスタンスをterminateし、attemptがMAX未満ならリトライ指示のみでfailedにはしない", async () => {
    ddbMock.on(GetCommand).resolves({ Item: baseJob });
    ec2Mock.on(TerminateInstancesCommand).resolves({});

    const { handler } = await import("./handleFailure.js");
    const result = await handler({ jobId: "job-1", attempt: 1 });

    expect(result).toEqual({ shouldRetry: true });
    expect(ec2Mock.commandCalls(TerminateInstancesCommand)[0]?.args[0].input).toEqual({
      InstanceIds: ["i-abc123"],
    });
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it("attemptが上限に達したらジョブをfailedにする", async () => {
    ddbMock.on(GetCommand).resolves({ Item: baseJob });
    ec2Mock.on(TerminateInstancesCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({});

    const { handler } = await import("./handleFailure.js");
    const result = await handler({ jobId: "job-1", attempt: MAX_ATTEMPTS });

    expect(result).toEqual({ shouldRetry: false });
    const updateCall = ddbMock.commandCalls(UpdateCommand)[0];
    expect(updateCall?.args[0].input.ExpressionAttributeValues).toMatchObject({ ":s": "failed" });
  });

  it("既に完了(done)しているジョブは待機中の完走とみなしterminateもfailed更新もしない", async () => {
    ddbMock.on(GetCommand).resolves({ Item: { ...baseJob, status: "done" } });

    const { handler } = await import("./handleFailure.js");
    const result = await handler({ jobId: "job-1", attempt: MAX_ATTEMPTS });

    expect(result).toEqual({ shouldRetry: false });
    expect(ec2Mock.commandCalls(TerminateInstancesCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it("既に終端状態(failed)のジョブは上書きしない", async () => {
    ddbMock.on(GetCommand).resolves({ Item: { ...baseJob, status: "failed" } });
    ec2Mock.on(TerminateInstancesCommand).resolves({});

    const { handler } = await import("./handleFailure.js");
    const result = await handler({ jobId: "job-1", attempt: MAX_ATTEMPTS });

    expect(result).toEqual({ shouldRetry: false });
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it("instanceIdが無ければterminateを呼ばない", async () => {
    ddbMock.on(GetCommand).resolves({ Item: { ...baseJob, instanceId: null } });

    const { handler } = await import("./handleFailure.js");
    await handler({ jobId: "job-1", attempt: 1 });

    expect(ec2Mock.commandCalls(TerminateInstancesCommand)).toHaveLength(0);
  });
});
