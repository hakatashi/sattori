import { beforeEach, describe, expect, it, vi } from "vitest";
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import { mockClient } from "aws-sdk-client-mock";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import type { AdminRetryJobResponse, JobRecord } from "@sattori/shared";
import { buildRetryJob } from "./retryJob.js";

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
  SES_FROM_ADDRESS: "no-reply@sattori.hakatashi.com",
  WEB_BASE_URL: "https://sattori.hakatashi.com",
  STATE_MACHINE_ARN: "arn:aws:states:us-east-1:123456789012:stateMachine:RecordingStateMachine",
};

const ddbMock = mockClient(DynamoDBDocumentClient);
const s3Mock = mockClient(S3Client);
const sfnMock = mockClient(SFNClient);

const failedJob: JobRecord = {
  jobId: "job-1",
  game: "th11",
  replayKey: "replays/abc.rpy",
  status: "failed",
  options: { watermark: false },
  outputPath: "videos/job-1.mp4",
  outputPath720p: null,
  error: "録画に複数回失敗しました",
  createdAt: "2026-07-18T00:00:00.000Z",
  updatedAt: "2026-07-18T01:00:00.000Z",
  doneAt: null,
  email: "user@example.com",
  instanceId: "i-1234",
  instanceType: "c7i.2xlarge",
  availabilityZone: "us-east-1a",
  estimatedDurationSeconds: 900,
  progress: 120,
  previewImagePath: "progress/job-1/1234.jpg",
  replayInfo: null,
  pendingExpiresAt: null,
  retriedToJobId: null,
  retriedFromJobId: null,
  language: "en",
};

function makeEvent(jobId?: string): APIGatewayProxyEventV2 {
  return { pathParameters: jobId ? { jobId } : {} } as unknown as APIGatewayProxyEventV2;
}

function parseBody(res: APIGatewayProxyStructuredResultV2): AdminRetryJobResponse {
  return JSON.parse(res.body ?? "{}") as AdminRetryJobResponse;
}

async function invoke(jobId?: string): Promise<APIGatewayProxyStructuredResultV2> {
  const { handler } = await import("./retryJob.js");
  return (await handler(makeEvent(jobId), {} as never, () => {})) as APIGatewayProxyStructuredResultV2;
}

describe("buildRetryJob", () => {
  it("入力側のフィールドを引き継ぎ、実行結果側を初期化する", () => {
    const retried = buildRetryJob(failedJob, "job-2", new Date("2026-08-01T00:00:00.000Z"));

    // 引き継ぐもの
    expect(retried.game).toBe("th11");
    expect(retried.replayKey).toBe("replays/abc.rpy");
    expect(retried.options).toEqual({ watermark: false });
    expect(retried.email).toBe("user@example.com");
    expect(retried.language).toBe("en");
    expect(retried.estimatedDurationSeconds).toBe(900);

    // 初期化するもの
    expect(retried.jobId).toBe("job-2");
    expect(retried.status).toBe("queued");
    expect(retried.outputPath).toBeNull();
    expect(retried.previewImagePath).toBeNull();
    expect(retried.progress).toBeNull();
    expect(retried.error).toBeNull();
    expect(retried.instanceId).toBeNull();
    expect(retried.instanceType).toBeNull();
    expect(retried.availabilityZone).toBeNull();
    expect(retried.pendingExpiresAt).toBeNull();
    expect(retried.createdAt).toBe("2026-08-01T00:00:00.000Z");
    expect(retried.updatedAt).toBe("2026-08-01T00:00:00.000Z");
    expect(retried.retriedFromJobId).toBe("job-1");
    expect(retried.retriedToJobId).toBeNull();
  });
});

describe("POST /admin/jobs/{jobId}/retry", () => {
  beforeEach(() => {
    ddbMock.reset();
    s3Mock.reset();
    sfnMock.reset();
    for (const [key, value] of Object.entries(REQUIRED_ENV)) {
      vi.stubEnv(key, value);
    }
    vi.stubEnv("AWS_ACCESS_KEY_ID", "dummy");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "dummy");
    vi.stubEnv("AWS_REGION", "us-east-1");
  });

  it("新しいjobIdでジョブを複製し、Step Functionsを起動して元ジョブにリンクを記録する", async () => {
    ddbMock.on(GetCommand).resolves({ Item: failedJob });
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({});
    s3Mock.on(HeadObjectCommand).resolves({});
    sfnMock.on(StartExecutionCommand).resolves({ executionArn: "arn:...", startDate: new Date() });

    const res = await invoke("job-1");
    const body = parseBody(res);

    expect(res.statusCode).toBe(200);
    expect(body.sourceJobId).toBe("job-1");
    expect(body.status).toBe("queued");
    expect(body.jobId).not.toBe("job-1");

    const putItem = ddbMock.commandCalls(PutCommand)[0]?.args[0].input.Item as JobRecord;
    expect(putItem.jobId).toBe(body.jobId);
    expect(putItem.status).toBe("queued");
    expect(putItem.replayKey).toBe("replays/abc.rpy");
    expect(putItem.retriedFromJobId).toBe("job-1");

    // Step Functionsの実行名は新しいjobId（同名再実行によるExecutionAlreadyExistsを避ける）。
    const startCall = sfnMock.commandCalls(StartExecutionCommand)[0];
    expect(startCall?.args[0].input.name).toBe(body.jobId);
    expect(JSON.parse(startCall?.args[0].input.input ?? "{}")).toEqual({
      jobId: body.jobId,
      attempt: 1,
    });

    // 元ジョブ側にretriedToJobIdを記録する（詳細画面から新ジョブへ辿るため）。
    const updateCall = ddbMock.commandCalls(UpdateCommand)[0];
    expect(updateCall?.args[0].input.Key).toEqual({ jobId: "job-1" });
    expect(updateCall?.args[0].input.ExpressionAttributeValues?.[":r"]).toBe(body.jobId);
  });

  it("doneのジョブも再実行できる", async () => {
    ddbMock.on(GetCommand).resolves({ Item: { ...failedJob, status: "done" } });
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({});
    s3Mock.on(HeadObjectCommand).resolves({});
    sfnMock.on(StartExecutionCommand).resolves({});

    expect((await invoke("job-1")).statusCode).toBe(200);
  });

  it("実行中のジョブは409で拒否する(同一リプレイの二重録画を避ける)", async () => {
    ddbMock.on(GetCommand).resolves({ Item: { ...failedJob, status: "recording" } });

    const res = await invoke("job-1");

    expect(res.statusCode).toBe(409);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    expect(sfnMock.commandCalls(StartExecutionCommand)).toHaveLength(0);
  });

  it("元の.rpyが残っていなければ409で拒否し、ジョブを作らない", async () => {
    ddbMock.on(GetCommand).resolves({ Item: failedJob });
    s3Mock.on(HeadObjectCommand).rejects(new Error("NotFound"));

    const res = await invoke("job-1");

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body ?? "{}").code).toBe("replay_missing");
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    expect(sfnMock.commandCalls(StartExecutionCommand)).toHaveLength(0);
  });

  it("StartExecutionに失敗したら新ジョブをfailedに落として502を返す", async () => {
    ddbMock.on(GetCommand).resolves({ Item: failedJob });
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({});
    s3Mock.on(HeadObjectCommand).resolves({});
    sfnMock.on(StartExecutionCommand).rejects(new Error("throttled"));

    const res = await invoke("job-1");

    expect(res.statusCode).toBe(502);
    const newJobId = (ddbMock.commandCalls(PutCommand)[0]?.args[0].input.Item as JobRecord).jobId;
    const updateCall = ddbMock.commandCalls(UpdateCommand)[0];
    expect(updateCall?.args[0].input.Key).toEqual({ jobId: newJobId });
    expect(updateCall?.args[0].input.ExpressionAttributeValues?.[":s"]).toBe("failed");
  });

  it("元ジョブへのリンク記録に失敗しても再実行自体は成功として返す", async () => {
    ddbMock.on(GetCommand).resolves({ Item: failedJob });
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(UpdateCommand).rejects(new Error("throttled"));
    s3Mock.on(HeadObjectCommand).resolves({});
    sfnMock.on(StartExecutionCommand).resolves({});

    expect((await invoke("job-1")).statusCode).toBe(200);
  });

  it("ジョブが存在しなければ404を返す", async () => {
    ddbMock.on(GetCommand).resolves({});
    expect((await invoke("job-x")).statusCode).toBe(404);
  });

  it("jobIdが無ければ400を返す", async () => {
    expect((await invoke()).statusCode).toBe(400);
  });
});
