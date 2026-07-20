import { beforeEach, describe, expect, it, vi } from "vitest";
import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import { marshall } from "@aws-sdk/util-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import type { AttributeValue, DynamoDBRecord, DynamoDBStreamEvent } from "aws-lambda";
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
};

const sesMock = mockClient(SESv2Client);

function baseJob(overrides: Partial<JobRecord>): JobRecord {
  return {
    jobId: "job-1",
    game: "th07",
    replayKey: "replays/abc.rpy",
    status: "recording",
    options: { watermark: true },
    outputPath: null,
    outputPath720p: null,
    error: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    email: "user@example.com",
    instanceId: null,
    estimatedDurationSeconds: null,
    progress: null,
    previewImagePath: null,
    pendingExpiresAt: null,
    ...overrides,
  };
}

function toStreamImage(job: JobRecord): Record<string, AttributeValue> {
  return marshall(job, { removeUndefinedValues: true }) as unknown as Record<
    string,
    AttributeValue
  >;
}

function modifyRecord(oldJob: JobRecord, newJob: JobRecord): DynamoDBRecord {
  return {
    eventName: "MODIFY",
    dynamodb: {
      NewImage: toStreamImage(newJob),
      OldImage: toStreamImage(oldJob),
    },
  };
}

describe("sendCompletionEmail (DynamoDB Streams)", () => {
  beforeEach(() => {
    vi.resetModules();
    sesMock.reset();
    for (const [key, value] of Object.entries(REQUIRED_ENV)) {
      vi.stubEnv(key, value);
    }
    sesMock.on(SendEmailCommand).resolves({});
  });

  it("statusがdoneへ遷移したレコードで完了メールを送る", async () => {
    const { handler } = await import("./sendCompletionEmail.js");
    const event: DynamoDBStreamEvent = {
      Records: [
        modifyRecord(
          baseJob({ status: "converting" }),
          baseJob({ status: "done", outputPath: "out/job-1.mp4" }),
        ),
      ],
    };

    await handler(event, {} as never, () => {});

    const calls = sesMock.commandCalls(SendEmailCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[0].input.Destination?.ToAddresses).toEqual(["user@example.com"]);
    const body = calls[0]?.args[0].input.Content?.Simple?.Body?.Text?.Data ?? "";
    expect(body).toContain("https://sattori.hakatashi.com/jobs/job-1");
  });

  it("doneからdoneへの更新（進捗等の再更新）ではメールを送らない", async () => {
    const { handler } = await import("./sendCompletionEmail.js");
    const event: DynamoDBStreamEvent = {
      Records: [
        modifyRecord(
          baseJob({ status: "done", outputPath: "out/job-1.mp4" }),
          baseJob({ status: "done", outputPath: "out/job-1.mp4", progress: 100 }),
        ),
      ],
    };

    await handler(event, {} as never, () => {});

    expect(sesMock.commandCalls(SendEmailCommand)).toHaveLength(0);
  });

  it("done以外への遷移ではメールを送らない", async () => {
    const { handler } = await import("./sendCompletionEmail.js");
    const event: DynamoDBStreamEvent = {
      Records: [
        modifyRecord(baseJob({ status: "recording" }), baseJob({ status: "converting" })),
      ],
    };

    await handler(event, {} as never, () => {});

    expect(sesMock.commandCalls(SendEmailCommand)).toHaveLength(0);
  });

  it("メールアドレスが無ければ送らない", async () => {
    const { handler } = await import("./sendCompletionEmail.js");
    const event: DynamoDBStreamEvent = {
      Records: [
        modifyRecord(baseJob({ status: "converting", email: null }), baseJob({ status: "done", email: null })),
      ],
    };

    await handler(event, {} as never, () => {});

    expect(sesMock.commandCalls(SendEmailCommand)).toHaveLength(0);
  });

  it("メール送信に失敗しても例外を投げず後続レコードを処理する", async () => {
    sesMock.on(SendEmailCommand).rejectsOnce(new Error("SES unavailable")).resolves({});
    const { handler } = await import("./sendCompletionEmail.js");
    const event: DynamoDBStreamEvent = {
      Records: [
        modifyRecord(
          baseJob({ jobId: "job-1", status: "converting" }),
          baseJob({ jobId: "job-1", status: "done" }),
        ),
        modifyRecord(
          baseJob({ jobId: "job-2", status: "converting" }),
          baseJob({ jobId: "job-2", status: "done" }),
        ),
      ],
    };

    await expect(handler(event, {} as never, () => {})).resolves.toBeUndefined();
    expect(sesMock.commandCalls(SendEmailCommand)).toHaveLength(2);
  });
});
