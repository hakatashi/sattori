import { beforeEach, describe, expect, it, vi } from "vitest";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { EC2Client, TerminateInstancesCommand } from "@aws-sdk/client-ec2";
import { ExecutionDoesNotExist, SFNClient, StopExecutionCommand } from "@aws-sdk/client-sfn";
import { mockClient } from "aws-sdk-client-mock";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import type { AdminStopJobResponse, JobRecord } from "@sattori/shared";

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
const ec2Mock = mockClient(EC2Client);
const sfnMock = mockClient(SFNClient);

const recordingJob: JobRecord = {
  jobId: "job-1",
  game: "th11",
  replayKey: "replays/abc.rpy",
  status: "recording",
  options: { watermark: true },
  outputPath: null,
  outputPath720p: null,
  error: null,
  createdAt: "2026-07-18T00:00:00.000Z",
  updatedAt: "2026-07-18T00:00:00.000Z",
  doneAt: null,
  email: "user@example.com",
  instanceId: "i-1234",
  instanceType: "c7i.2xlarge",
  availabilityZone: "us-east-1a",
  estimatedDurationSeconds: 900,
  progress: 120,
  previewImagePath: null,
  replayInfo: null,
  pendingExpiresAt: null,
  retriedToJobId: null,
  retriedFromJobId: null,
  language: "ja",
};

function makeEvent(jobId?: string): APIGatewayProxyEventV2 {
  return { pathParameters: jobId ? { jobId } : {} } as unknown as APIGatewayProxyEventV2;
}

function parseBody(res: APIGatewayProxyStructuredResultV2): AdminStopJobResponse {
  return JSON.parse(res.body ?? "{}") as AdminStopJobResponse;
}

async function invoke(jobId?: string): Promise<APIGatewayProxyStructuredResultV2> {
  const { handler } = await import("./stopJob.js");
  return (await handler(makeEvent(jobId), {} as never, () => {})) as APIGatewayProxyStructuredResultV2;
}

describe("POST /admin/jobs/{jobId}/stop", () => {
  beforeEach(() => {
    ddbMock.reset();
    ec2Mock.reset();
    sfnMock.reset();
    for (const [key, value] of Object.entries(REQUIRED_ENV)) {
      vi.stubEnv(key, value);
    }
    vi.stubEnv("AWS_REGION", "us-east-1");
  });

  it("実行停止→インスタンス終了→failed確定の順に処理する", async () => {
    ddbMock.on(GetCommand).resolves({ Item: recordingJob });
    ddbMock.on(UpdateCommand).resolves({});
    sfnMock.on(StopExecutionCommand).resolves({});
    ec2Mock.on(TerminateInstancesCommand).resolves({});

    const res = await invoke("job-1");
    const body = parseBody(res);

    expect(res.statusCode).toBe(200);
    expect(body).toEqual({
      jobId: "job-1",
      status: "failed",
      executionStopped: true,
      instanceTerminated: true,
    });

    // 実行名=jobIdからexecutionArnを決定的に導出している。
    const stopCall = sfnMock.commandCalls(StopExecutionCommand)[0];
    expect(stopCall?.args[0].input.executionArn).toBe(
      "arn:aws:states:us-east-1:123456789012:execution:RecordingStateMachine:job-1",
    );
    expect(ec2Mock.commandCalls(TerminateInstancesCommand)[0]?.args[0].input.InstanceIds).toEqual([
      "i-1234",
    ]);

    const updateCall = ddbMock.commandCalls(UpdateCommand)[0];
    expect(updateCall?.args[0].input.ExpressionAttributeValues?.[":s"]).toBe("failed");
    expect(updateCall?.args[0].input.ExpressionAttributeValues?.[":e"]).toBe(
      "管理者により停止されました",
    );
  });

  it("実行がまだ存在しない場合もインスタンス終了と状態確定は行う", async () => {
    ddbMock.on(GetCommand).resolves({ Item: { ...recordingJob, status: "launching" } });
    ddbMock.on(UpdateCommand).resolves({});
    sfnMock
      .on(StopExecutionCommand)
      .rejects(new ExecutionDoesNotExist({ message: "does not exist", $metadata: {} }));
    ec2Mock.on(TerminateInstancesCommand).resolves({});

    const body = parseBody(await invoke("job-1"));

    expect(body.executionStopped).toBe(false);
    expect(body.instanceTerminated).toBe(true);
    expect(body.status).toBe("failed");
  });

  it("instanceIdが未記録なら terminate は呼ばない", async () => {
    ddbMock.on(GetCommand).resolves({ Item: { ...recordingJob, status: "queued", instanceId: null } });
    ddbMock.on(UpdateCommand).resolves({});
    sfnMock.on(StopExecutionCommand).resolves({});

    const body = parseBody(await invoke("job-1"));

    expect(ec2Mock.commandCalls(TerminateInstancesCommand)).toHaveLength(0);
    expect(body.instanceTerminated).toBe(false);
  });

  it("終端状態のジョブは409で拒否する", async () => {
    ddbMock.on(GetCommand).resolves({ Item: { ...recordingJob, status: "done" } });

    const res = await invoke("job-1");

    expect(res.statusCode).toBe(409);
    expect(sfnMock.commandCalls(StopExecutionCommand)).toHaveLength(0);
    expect(ec2Mock.commandCalls(TerminateInstancesCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it("StopExecutionが失敗したらインスタンスを終了せず状態も変更しない", async () => {
    // 先にterminateしてしまうと、taskToken応答が来なくなった実行がタイムアウト後に
    // リトライへ回り、停止したはずのジョブが再起動してしまう。
    ddbMock.on(GetCommand).resolves({ Item: recordingJob });
    sfnMock.on(StopExecutionCommand).rejects(new Error("throttled"));

    const res = await invoke("job-1");

    expect(res.statusCode).toBe(502);
    expect(ec2Mock.commandCalls(TerminateInstancesCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it("terminateが失敗したらfailedへの確定を行わない(止まっていないのに終了扱いにしない)", async () => {
    ddbMock.on(GetCommand).resolves({ Item: recordingJob });
    sfnMock.on(StopExecutionCommand).resolves({});
    ec2Mock.on(TerminateInstancesCommand).rejects(new Error("RequestLimitExceeded"));

    const res = await invoke("job-1");

    expect(res.statusCode).toBe(502);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it("ジョブが存在しなければ404を返す", async () => {
    ddbMock.on(GetCommand).resolves({});
    expect((await invoke("job-x")).statusCode).toBe(404);
  });

  it("jobIdが無ければ400を返す", async () => {
    expect((await invoke()).statusCode).toBe(400);
  });
});
