import { beforeEach, describe, expect, it, vi } from "vitest";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import type { GetJobResponse, JobRecord, ReplayInfo } from "@sattori/shared";

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

const ddbMock = mockClient(DynamoDBDocumentClient);

const REPLAY_INFO: ReplayInfo = {
  game: "th11",
  player: "koyi",
  date: "01/18",
  character: "霊夢A",
  difficulty: "Lunatic",
  stage: null,
  score: 442469780,
  cleared: true,
  estimatedDurationSeconds: 847,
};

const doneJob: JobRecord = {
  jobId: "job-1",
  game: "th11",
  replayKey: "replays/abc.rpy",
  status: "done",
  options: { watermark: true },
  outputPath: "output/job-1/video.mp4",
  outputPath720p: "output/job-1/video-720p.mp4",
  error: null,
  createdAt: "2026-07-18T00:00:00.000Z",
  updatedAt: "2026-07-18T00:00:00.000Z",
  doneAt: "2026-07-18T00:00:00.000Z",
  email: "user@example.com",
  instanceId: "i-1234",
  instanceType: "c7i.2xlarge",
  availabilityZone: "us-east-1a",
  estimatedDurationSeconds: 900,
  progress: null,
  previewImagePath: null,
  replayInfo: REPLAY_INFO,
  pendingExpiresAt: "2099-01-01T00:00:00.000Z",
  language: "ja",
};

function makeEvent(jobId: string): APIGatewayProxyEventV2 {
  return { pathParameters: { jobId } } as unknown as APIGatewayProxyEventV2;
}

function parseBody(res: APIGatewayProxyStructuredResultV2): GetJobResponse {
  return JSON.parse(res.body ?? "{}") as GetJobResponse;
}

describe("GET /jobs/{jobId}", () => {
  beforeEach(() => {
    ddbMock.reset();
    for (const [key, value] of Object.entries(REQUIRED_ENV)) {
      vi.stubEnv(key, value);
    }
  });

  it("完了ジョブは response-content-disposition クエリ付きのダウンロードURLを返す(ブラウザ標準のダウンロード機構を使わせるため)", async () => {
    ddbMock.on(GetCommand).resolves({ Item: doneJob });

    const { handler } = await import("./getJob.js");
    const res = await handler(makeEvent("job-1"), {} as never, () => {});
    const body = parseBody(res as APIGatewayProxyStructuredResultV2);

    expect(body.downloadUrl720p).toBeTruthy();
    const url720p = new URL(body.downloadUrl720p as string);
    expect(url720p.origin + url720p.pathname).toBe(
      "https://cdn.example.net/output/job-1/video-720p.mp4",
    );
    const disposition720p = url720p.searchParams.get("response-content-disposition");
    expect(disposition720p).toContain("attachment;");
    expect(disposition720p).toContain(
      "filename*=UTF-8''%E6%9D%B1%E6%96%B9%E5%9C%B0%E9%9C%8A%E6%AE%BF",
    );

    expect(body.downloadUrl).toBeTruthy();
    const urlOriginal = new URL(body.downloadUrl as string);
    expect(urlOriginal.origin + urlOriginal.pathname).toBe(
      "https://cdn.example.net/output/job-1/video.mp4",
    );
    // 720p版とオリジナル解像度版はファイル名(disposition)で区別できる。
    expect(urlOriginal.searchParams.get("response-content-disposition")).not.toBe(disposition720p);
  });

  it("完了ジョブは doneAt + OUTPUT_RETENTION_DAYS(7日) をダウンロード期限として返す", async () => {
    ddbMock.on(GetCommand).resolves({ Item: doneJob });

    const { handler } = await import("./getJob.js");
    const res = await handler(makeEvent("job-1"), {} as never, () => {});
    const body = parseBody(res as APIGatewayProxyStructuredResultV2);

    expect(body.downloadExpiresAt).toBe("2026-07-25T00:00:00.000Z");
  });

  it("doneAt未設定の旧ジョブはダウンロード期限を返さない", async () => {
    ddbMock.on(GetCommand).resolves({ Item: { ...doneJob, doneAt: null } });

    const { handler } = await import("./getJob.js");
    const res = await handler(makeEvent("job-1"), {} as never, () => {});
    const body = parseBody(res as APIGatewayProxyStructuredResultV2);

    expect(body.downloadExpiresAt).toBeNull();
  });

  it("録画中(done以外)のジョブはダウンロードURL・期限を返さない", async () => {
    ddbMock.on(GetCommand).resolves({ Item: { ...doneJob, status: "recording" } });

    const { handler } = await import("./getJob.js");
    const res = await handler(makeEvent("job-1"), {} as never, () => {});
    const body = parseBody(res as APIGatewayProxyStructuredResultV2);

    expect(body.downloadUrl).toBeNull();
    expect(body.downloadUrl720p).toBeNull();
    expect(body.downloadExpiresAt).toBeNull();
  });

  it("ジョブが存在しなければ404を返す", async () => {
    ddbMock.on(GetCommand).resolves({});
    const { handler } = await import("./getJob.js");
    const res = await handler(makeEvent("missing"), {} as never, () => {});
    expect((res as APIGatewayProxyStructuredResultV2).statusCode).toBe(404);
  });
});
