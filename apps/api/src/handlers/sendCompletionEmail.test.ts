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
  SETTINGS_TABLE: "sattori-settings",
  WORKERS_TABLE: "sattori-workers",
  SES_FROM_ADDRESS: "no-reply@sattori.hakatashi.com",
  SES_CONFIGURATION_SET: "sattori-config-set",
  WEB_BASE_URL: "https://sattori.hakatashi.com",
};

const sesMock = mockClient(SESv2Client);

function baseJob(overrides: Partial<JobRecord>): JobRecord {
  return {
    jobId: "job-1",
    game: "th07",
    replayKey: "replays/abc.rpy",
    status: "recording",
    options: { watermark: true, slowMotion: false },
    outputPath: null,
    outputPath720p: null,
    error: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    doneAt: null,
    email: "user@example.com",
    instanceId: null,
    workerKind: null,
    instanceType: null,
    availabilityZone: null,
    spotPricePerHour: null,
    launchedAt: null,
    outputBytes: null,
    outputBytes720p: null,
    estimatedDurationSeconds: null,
    progress: null,
    previewImagePath: null,
    replayInfo: null,
    pendingExpiresAt: null,
    retriedToJobId: null,
    retriedFromJobId: null,
    language: "ja",
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

  it("ジョブのreplayInfoを完了メール本文の概要ブロックに載せる", async () => {
    const { handler } = await import("./sendCompletionEmail.js");
    const replayInfo = {
      game: "th07" as const,
      player: "koyi",
      date: "01/18",
      character: "MarisaA",
      characterNameJa: "魔符",
      characterNameEn: "Marisa A",
      difficulty: "Extra",
      stage: null,
      score: 303766040,
      cleared: true,
      estimatedDurationSeconds: 847,
    };
    const event: DynamoDBStreamEvent = {
      Records: [
        modifyRecord(
          baseJob({ status: "converting", replayInfo }),
          baseJob({ status: "done", outputPath: "out/job-1.mp4", replayInfo }),
        ),
      ],
    };

    await handler(event, {} as never, () => {});

    const calls = sesMock.commandCalls(SendEmailCommand);
    const body = calls[0]?.args[0].input.Content?.Simple?.Body?.Text?.Data ?? "";
    expect(body).toContain("【作品タイトル】東方妖々夢 ～ Perfect Cherry Blossom.");
    expect(body).toContain("【自機タイプ】魔符");
    expect(body).toContain("【スコア】303,766,040");
  });

  it("languageがenのジョブなら英語の文面・/enリンクで完了メールを送る", async () => {
    const { handler } = await import("./sendCompletionEmail.js");
    const event: DynamoDBStreamEvent = {
      Records: [
        modifyRecord(
          baseJob({ status: "converting", language: "en" }),
          baseJob({ status: "done", outputPath: "out/job-1.mp4", language: "en" }),
        ),
      ],
    };

    await handler(event, {} as never, () => {});

    const calls = sesMock.commandCalls(SendEmailCommand);
    expect(calls[0]?.args[0].input.Content?.Simple?.Subject?.Data).not.toMatch(/録画/);
    const body = calls[0]?.args[0].input.Content?.Simple?.Body?.Text?.Data ?? "";
    expect(body).toContain("https://sattori.hakatashi.com/en/jobs/job-1");
  });

  it("languageが無い旧ジョブレコードはjaにフォールバックする", async () => {
    const { handler } = await import("./sendCompletionEmail.js");
    const oldJob = baseJob({ status: "converting" }) as Partial<JobRecord>;
    const newJob = baseJob({ status: "done", outputPath: "out/job-1.mp4" }) as Partial<JobRecord>;
    delete oldJob.language;
    delete newJob.language;
    const event: DynamoDBStreamEvent = {
      Records: [
        {
          eventName: "MODIFY",
          dynamodb: {
            NewImage: toStreamImage(newJob as JobRecord),
            OldImage: toStreamImage(oldJob as JobRecord),
          },
        },
      ],
    };

    await handler(event, {} as never, () => {});

    const calls = sesMock.commandCalls(SendEmailCommand);
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
