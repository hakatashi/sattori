import { beforeEach, describe, expect, it, vi } from "vitest";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import type { AdminJobDetailResponse, JobRecord } from "@sattori/shared";

const REQUIRED_ENV: Record<string, string> = {
  UPLOAD_BUCKET: "up-bucket",
  OUTPUT_BUCKET: "out-bucket",
  CDN_DOMAIN: "cdn.example.net",
  JOBS_TABLE: "sattori-jobs",
  WORKER_IMAGE: "123456789012.dkr.ecr.us-east-1.amazonaws.com/sattori-worker:latest",
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

const ddbMock = mockClient(DynamoDBDocumentClient);
const s3Mock = mockClient(S3Client);

const recordingJob: JobRecord = {
  jobId: "job-1",
  game: "th11",
  replayKey: "replays/abc.rpy",
  status: "recording",
  options: { watermark: true, slowMotion: false },
  outputPath: "videos/job-1.mp4",
  outputPath720p: null,
  error: null,
  errorCode: null,
  createdAt: "2026-07-18T00:00:00.000Z",
  updatedAt: "2026-07-18T00:00:00.000Z",
  doneAt: null,
  email: "user@example.com",
  instanceId: "i-1234",
  workerKind: null,
  instanceType: "c7i.2xlarge",
  availabilityZone: "us-east-1a",
  spotPricePerHour: null,
  launchedAt: null,
  outputBytes: null,
  outputBytes720p: null,
  estimatedDurationSeconds: 900,
  progress: 120,
  previewImagePath: "progress/job-1/1234.jpg",
  replayInfo: null,
  pendingExpiresAt: null,
  retriedToJobId: null,
  retriedFromJobId: null,
  language: "ja",
};

function makeEvent(jobId: string): APIGatewayProxyEventV2 {
  return { pathParameters: { jobId } } as unknown as APIGatewayProxyEventV2;
}

function parseBody(res: APIGatewayProxyStructuredResultV2): AdminJobDetailResponse {
  return JSON.parse(res.body ?? "{}") as AdminJobDetailResponse;
}

describe("GET /admin/jobs/{jobId}", () => {
  beforeEach(() => {
    ddbMock.reset();
    s3Mock.reset();
    for (const [key, value] of Object.entries(REQUIRED_ENV)) {
      vi.stubEnv(key, value);
    }
    vi.stubEnv("AWS_ACCESS_KEY_ID", "dummy");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "dummy");
    vi.stubEnv("AWS_REGION", "us-east-1");
  });

  it("JobRecordをそのまま返し、statusがdoneでなくてもoutputPathがあればvideoUrlを返す", async () => {
    ddbMock.on(GetCommand).resolves({ Item: recordingJob });
    s3Mock.on(HeadObjectCommand).resolves({});

    const { handler } = await import("./getJobDetail.js");
    const res = await handler(makeEvent("job-1"), {} as never, () => {});
    const body = parseBody(res as APIGatewayProxyStructuredResultV2);

    expect(body.job).toEqual(recordingJob);
    expect(body.job.email).toBe("user@example.com");
    expect(body.job.instanceId).toBe("i-1234");
    expect(body.downloads.videoUrl).toBeTruthy();
    expect(body.downloads.video720pUrl).toBeNull();
    expect(body.downloads.previewImageUrl).toBe("https://cdn.example.net/progress/job-1/1234.jpg");
  });

  it("homeWorkerEnvのTASK_TOKENは伏せて返す(他の環境変数は残す)", async () => {
    // 生きたtaskTokenはStep Functionsの実行を任意に成功/失敗させられるベアラで、
    // レスポンスに載せるとブラウザのdevtools・HAR・アクセスログにまで漏れる。
    ddbMock.on(GetCommand).resolves({
      Item: {
        ...recordingJob,
        homeWorkerEnv: { JOB_ID: "job-1", GAME: "th11", TASK_TOKEN: "live-task-token" },
      },
    });
    s3Mock.on(HeadObjectCommand).resolves({});

    const { handler } = await import("./getJobDetail.js");
    const res = (await handler(makeEvent("job-1"), {} as never, () => {})) as APIGatewayProxyStructuredResultV2;
    const body = parseBody(res);

    expect(body.job.homeWorkerEnv).toEqual({ JOB_ID: "job-1", GAME: "th11" });
    expect(res.body).not.toContain("live-task-token");
  });

  it("署名付きreplayUrlにX-Amz-Signatureとresponse-content-dispositionが含まれる", async () => {
    ddbMock.on(GetCommand).resolves({ Item: recordingJob });
    s3Mock.on(HeadObjectCommand).resolves({});

    const { handler } = await import("./getJobDetail.js");
    const res = await handler(makeEvent("job-1"), {} as never, () => {});
    const body = parseBody(res as APIGatewayProxyStructuredResultV2);

    expect(body.downloads.replayUrl).toBeTruthy();
    const url = new URL(body.downloads.replayUrl as string);
    expect(url.searchParams.get("X-Amz-Signature")).toBeTruthy();
    expect(url.searchParams.get("response-content-disposition")).toContain("job-1.rpy");
  });

  it("HeadObjectが失敗する(.rpyが存在しない)場合はreplayUrl: null", async () => {
    ddbMock.on(GetCommand).resolves({ Item: recordingJob });
    s3Mock.on(HeadObjectCommand).rejects(new Error("NotFound"));

    const { handler } = await import("./getJobDetail.js");
    const res = await handler(makeEvent("job-1"), {} as never, () => {});
    const body = parseBody(res as APIGatewayProxyStructuredResultV2);

    expect(body.downloads.replayUrl).toBeNull();
  });

  it("ffmpegログのHeadObjectが成功すれば署名付きffmpegLogUrlを返す", async () => {
    ddbMock.on(GetCommand).resolves({ Item: recordingJob });
    s3Mock.on(HeadObjectCommand).resolves({});

    const { handler } = await import("./getJobDetail.js");
    const res = await handler(makeEvent("job-1"), {} as never, () => {});
    const body = parseBody(res as APIGatewayProxyStructuredResultV2);

    expect(body.downloads.ffmpegLogUrl).toBeTruthy();
    const url = new URL(body.downloads.ffmpegLogUrl as string);
    expect(url.pathname).toContain("worker-logs/job-1/ffmpeg-upscale.log");
  });

  it("ffmpegログが存在しない場合はffmpegLogUrl: nullを返す(他のダウンロードURLには影響しない)", async () => {
    ddbMock.on(GetCommand).resolves({ Item: recordingJob });
    s3Mock.on(HeadObjectCommand).resolves({});
    s3Mock
      .on(HeadObjectCommand, { Bucket: "out-bucket", Key: "worker-logs/job-1/ffmpeg-upscale.log" })
      .rejects(new Error("NotFound"));

    const { handler } = await import("./getJobDetail.js");
    const res = await handler(makeEvent("job-1"), {} as never, () => {});
    const body = parseBody(res as APIGatewayProxyStructuredResultV2);

    expect(body.downloads.ffmpegLogUrl).toBeNull();
    expect(body.downloads.replayUrl).toBeTruthy();
  });

  it("ジョブが存在しなければ404を返す", async () => {
    ddbMock.on(GetCommand).resolves({});
    const { handler } = await import("./getJobDetail.js");
    const res = await handler(makeEvent("missing"), {} as never, () => {});
    expect((res as APIGatewayProxyStructuredResultV2).statusCode).toBe(404);
  });
});
