import { beforeEach, describe, expect, it, vi } from "vitest";
import { CreateFleetCommand, CreateLaunchTemplateVersionCommand, EC2Client } from "@aws-sdk/client-ec2";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import type { JobRecord } from "@sattori/shared";

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

const job: JobRecord = {
  jobId: "job-1",
  game: "th07",
  replayKey: "replays/abc.rpy",
  status: "queued",
  options: { watermark: true },
  outputPath: null,
  outputPath720p: null,
  error: null,
  createdAt: "2026-07-17T00:00:00.000Z",
  updatedAt: "2026-07-17T00:00:00.000Z",
  email: null,
  instanceId: null,
  estimatedDurationSeconds: 900,
  progress: null,
  previewImagePath: null,
  replayInfo: null,
  pendingExpiresAt: null,
};

beforeEach(() => {
  vi.stubEnv("JOBS_TABLE", REQUIRED_ENV.JOBS_TABLE!);
  for (const [key, value] of Object.entries(REQUIRED_ENV)) {
    vi.stubEnv(key, value);
  }
  ec2Mock.reset();
  ddbMock.reset();
});

describe("sfn/launch handler", () => {
  it("ジョブを取得しEC2 Fleetで起動、statusとinstanceIdを更新する", async () => {
    ddbMock.on(GetCommand).resolves({ Item: job });
    ec2Mock
      .on(CreateLaunchTemplateVersionCommand)
      .resolves({ LaunchTemplateVersion: { VersionNumber: 2 } });
    ec2Mock.on(CreateFleetCommand).resolves({ Instances: [{ InstanceIds: ["i-abc123"] }] });
    ddbMock.on(UpdateCommand).resolves({});

    const { handler } = await import("./launch.js");
    await handler({ jobId: "job-1", attempt: 1, taskToken: "token-xyz" });

    expect(ec2Mock.commandCalls(CreateFleetCommand)).toHaveLength(1);
    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls.length).toBe(2);
    const updatedFields = updateCalls.map((call) => call.args[0].input.ExpressionAttributeValues);
    expect(updatedFields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ":s": "launching" }),
        expect.objectContaining({ ":i": "i-abc123" }),
      ]),
    );
  });

  it("ジョブが見つからなければ例外を投げる", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    const { handler } = await import("./launch.js");
    await expect(
      handler({ jobId: "missing-job", attempt: 1, taskToken: "token-xyz" }),
    ).rejects.toThrow(/ジョブが見つかりません/);
  });
});
