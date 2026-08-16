import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { DescribeInstancesCommand, EC2Client, TerminateInstancesCommand } from "@aws-sdk/client-ec2";
import {
  DescribeExecutionCommand,
  ExecutionDoesNotExist,
  SFNClient,
  StopExecutionCommand,
} from "@aws-sdk/client-sfn";
import { mockClient } from "aws-sdk-client-mock";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import type { AdminStopJobResponse, ApiError, JobRecord } from "@sattori/shared";

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
  options: { watermark: true, slowMotion: false },
  outputPath: null,
  outputPath720p: null,
  error: null,
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

/** statusを書き換えるUpdateItem（自宅ワーカーの割り当て解除と区別する）。 */
function statusUpdates() {
  return ddbMock
    .commandCalls(UpdateCommand)
    .filter((call) => call.args[0].input.ExpressionAttributeValues?.[":s"] !== undefined);
}

/** 緊急停止の拒否票（`stopRequestedAt`）を立てるUpdateItem。 */
function stopRequestedMarkers() {
  return ddbMock
    .commandCalls(UpdateCommand)
    .filter((call) =>
      String(call.args[0].input.UpdateExpression).includes("stopRequestedAt = :now"),
    );
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
    // 既定では「実行は生きている / タグ検索では追加のインスタンスは見つからない」。
    sfnMock.on(DescribeExecutionCommand).resolves({ status: "RUNNING" });
    ec2Mock.on(DescribeInstancesCommand).resolves({ Reservations: [] });
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
      homeWorkerReleased: false,
    });

    // 実行名=jobIdからexecutionArnを決定的に導出している。
    const stopCall = sfnMock.commandCalls(StopExecutionCommand)[0];
    expect(stopCall?.args[0].input.executionArn).toBe(
      "arn:aws:states:us-east-1:123456789012:execution:RecordingStateMachine:job-1",
    );
    expect(ec2Mock.commandCalls(TerminateInstancesCommand)[0]?.args[0].input.InstanceIds).toEqual([
      "i-1234",
    ]);

    const updateCall = statusUpdates()[0];
    expect(updateCall?.args[0].input.ExpressionAttributeValues?.[":s"]).toBe("failed");
    expect(updateCall?.args[0].input.ExpressionAttributeValues?.[":e"]).toBe(
      "管理者により停止されました",
    );

    // 拒否票（`stopRequestedAt`）は**ワーカーの後始末より先に**立てる。後に回すと、
    // 割り当て解除に気づく前に完走した自宅ワーカーのコンテナが`done`を書き、
    // 停止したはずのジョブの完了メールがユーザーへ飛ぶ。
    expect(stopRequestedMarkers()).toHaveLength(1);
    expect(
      String(ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input.UpdateExpression),
    ).toContain("stopRequestedAt = :now");
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

  it("instanceIdが未記録でタグ検索でも見つからなければ terminate は呼ばない", async () => {
    ddbMock.on(GetCommand).resolves({ Item: { ...recordingJob, status: "queued", instanceId: null } });
    ddbMock.on(UpdateCommand).resolves({});
    sfnMock.on(StopExecutionCommand).resolves({});

    const body = parseBody(await invoke("job-1"));

    expect(ec2Mock.commandCalls(TerminateInstancesCommand)).toHaveLength(0);
    expect(body.instanceTerminated).toBe(false);
  });

  it("instanceId未記録でもタグ(sattori:jobId)で見つけたインスタンスを終了する", async () => {
    // Launch LambdaはCreateFleetの後にinstanceIdを書くため、起動直後の停止では
    // DynamoDB側が未記録のまま。取り逃すと孤児インスタンスが課金され続ける。
    ddbMock.on(GetCommand).resolves({ Item: { ...recordingJob, status: "launching", instanceId: null } });
    ddbMock.on(UpdateCommand).resolves({});
    sfnMock.on(StopExecutionCommand).resolves({});
    ec2Mock
      .on(DescribeInstancesCommand)
      .resolves({ Reservations: [{ Instances: [{ InstanceId: "i-orphan" }] }] });
    ec2Mock.on(TerminateInstancesCommand).resolves({});

    const body = parseBody(await invoke("job-1"));

    const describeCall = ec2Mock.commandCalls(DescribeInstancesCommand)[0];
    expect(describeCall?.args[0].input.Filters).toEqual([
      { Name: "tag:sattori:jobId", Values: ["job-1"] },
      { Name: "instance-state-name", Values: ["pending", "running", "stopping", "stopped"] },
    ]);
    expect(ec2Mock.commandCalls(TerminateInstancesCommand)[0]?.args[0].input.InstanceIds).toEqual([
      "i-orphan",
    ]);
    expect(body.instanceTerminated).toBe(true);
  });

  it("タグ検索が失敗しても記録済みのinstanceIdは終了する", async () => {
    ddbMock.on(GetCommand).resolves({ Item: recordingJob });
    ddbMock.on(UpdateCommand).resolves({});
    sfnMock.on(StopExecutionCommand).resolves({});
    ec2Mock.on(DescribeInstancesCommand).rejects(new Error("RequestLimitExceeded"));
    ec2Mock.on(TerminateInstancesCommand).resolves({});

    const body = parseBody(await invoke("job-1"));

    expect(ec2Mock.commandCalls(TerminateInstancesCommand)[0]?.args[0].input.InstanceIds).toEqual([
      "i-1234",
    ]);
    expect(body.instanceTerminated).toBe(true);
  });

  it("終端状態で実行も終わっているジョブは409で拒否する", async () => {
    ddbMock.on(GetCommand).resolves({ Item: { ...recordingJob, status: "done" } });
    sfnMock.on(DescribeExecutionCommand).resolves({ status: "SUCCEEDED" });

    const res = await invoke("job-1");

    expect(res.statusCode).toBe(409);
    expect(sfnMock.commandCalls(StopExecutionCommand)).toHaveLength(0);
    expect(ec2Mock.commandCalls(TerminateInstancesCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it("実行が終わっていても生きたインスタンスが残っていれば停止できる(terminate失敗後の再停止)", async () => {
    // StopExecutionは成功したがterminateに失敗して502を返した後、管理者は同じ操作を
    // やり直す。ここで409を返すと孤児インスタンスを殺す手段が無くなる。
    ddbMock.on(GetCommand).resolves({ Item: { ...recordingJob, status: "failed" } });
    ddbMock.on(UpdateCommand).resolves({});
    sfnMock.on(DescribeExecutionCommand).resolves({ status: "ABORTED" });
    sfnMock.on(StopExecutionCommand).resolves({});
    ec2Mock
      .on(DescribeInstancesCommand)
      .resolves({ Reservations: [{ Instances: [{ InstanceId: "i-1234" }] }] });
    ec2Mock.on(TerminateInstancesCommand).resolves({});

    const res = await invoke("job-1");

    expect(res.statusCode).toBe(200);
    expect(parseBody(res).instanceTerminated).toBe(true);
  });

  it("StopExecutionの後に生まれたインスタンスも終了する", async () => {
    // Step Functionsは実行中のLambda呼び出しをキャンセルしないため、停止要求の後に
    // CreateFleetが完了することがある。停止前の検索だけでは取り逃す。
    ddbMock.on(GetCommand).resolves({ Item: { ...recordingJob, status: "launching", instanceId: null } });
    ddbMock.on(UpdateCommand).resolves({});
    sfnMock.on(StopExecutionCommand).resolves({});
    ec2Mock
      .on(DescribeInstancesCommand)
      .resolvesOnce({ Reservations: [] })
      .resolves({ Reservations: [{ Instances: [{ InstanceId: "i-late" }] }] });
    ec2Mock.on(TerminateInstancesCommand).resolves({});

    const body = parseBody(await invoke("job-1"));

    expect(ec2Mock.commandCalls(TerminateInstancesCommand)[0]?.args[0].input.InstanceIds).toEqual([
      "i-late",
    ]);
    expect(body.instanceTerminated).toBe(true);
  });

  it("statusがfailedでも実行が動いていれば停止できる(リトライループの暴走を止める)", async () => {
    // ワーカーはSendTaskFailureより先にfailedを書くため、statusだけで弾くと
    // 最大10回リトライし続けるジョブを止められなくなる。
    ddbMock.on(GetCommand).resolves({ Item: { ...recordingJob, status: "failed" } });
    ddbMock.on(UpdateCommand).resolves({});
    sfnMock.on(DescribeExecutionCommand).resolves({ status: "RUNNING" });
    sfnMock.on(StopExecutionCommand).resolves({});
    ec2Mock.on(TerminateInstancesCommand).resolves({});

    const res = await invoke("job-1");

    expect(res.statusCode).toBe(200);
    expect(sfnMock.commandCalls(StopExecutionCommand)).toHaveLength(1);
    expect(parseBody(res).status).toBe("failed");
  });

  it("実行状態を確認できなければ(判定不能)終端状態でも停止を試みる", async () => {
    ddbMock.on(GetCommand).resolves({ Item: { ...recordingJob, status: "failed" } });
    ddbMock.on(UpdateCommand).resolves({});
    sfnMock.on(DescribeExecutionCommand).rejects(new Error("throttled"));
    sfnMock.on(StopExecutionCommand).resolves({});
    ec2Mock.on(TerminateInstancesCommand).resolves({});

    expect((await invoke("job-1")).statusCode).toBe(200);
    expect(sfnMock.commandCalls(StopExecutionCommand)).toHaveLength(1);
  });

  it("停止処理中にワーカーが完走していたらdoneを上書きしない", async () => {
    // 完了メールは既に飛んでいるため、failedで上書きすると「完了メールは届いたのに
    // 画面はfailed」という食い違いになる。
    ddbMock.on(GetCommand).resolves({ Item: { ...recordingJob, status: "converting" } });
    ddbMock.on(UpdateCommand).resolves({});
    // 条件付きなのはstatus確定のUpdateItemだけ（自宅ワーカーの割り当て解除は無条件）。
    ddbMock
      .on(UpdateCommand, { ConditionExpression: "#s <> :done" })
      .rejects(new ConditionalCheckFailedException({ message: "conditional", $metadata: {} }));
    sfnMock.on(StopExecutionCommand).resolves({});
    ec2Mock.on(TerminateInstancesCommand).resolves({});

    const res = await invoke("job-1");
    const body = parseBody(res);

    expect(res.statusCode).toBe(200);
    expect(body.status).toBe("done");
    expect(body.executionStopped).toBe(true);
    // 条件付き更新であることの確認（無条件書き込みだとdoneを潰す）。
    expect(statusUpdates()[0]?.args[0].input.ConditionExpression).toBe("#s <> :done");
  });

  it("自宅ワーカー(Issue #49)のジョブでは割り当てを解除しhomeWorkerReleasedを返す", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        ...recordingJob,
        workerKind: "home",
        assignedWorkerId: "home-1",
        instanceId: null,
      },
    });
    ddbMock.on(UpdateCommand).resolves({});
    sfnMock.on(StopExecutionCommand).resolves({});

    const body = parseBody(await invoke("job-1"));

    expect(body.homeWorkerReleased).toBe(true);
    const releaseCall = ddbMock
      .commandCalls(UpdateCommand)
      .find((call) => call.args[0].input.UpdateExpression?.includes("assignedWorkerId"));
    expect(releaseCall).toBeDefined();
  });

  it("StopExecutionが失敗したらインスタンスを終了せず状態も変更しない", async () => {
    // 先にterminateしてしまうと、taskToken応答が来なくなった実行がタイムアウト後に
    // リトライへ回り、停止したはずのジョブが再起動してしまう。
    ddbMock.on(GetCommand).resolves({ Item: recordingJob });
    sfnMock.on(StopExecutionCommand).rejects(new Error("throttled"));

    const res = await invoke("job-1");

    expect(res.statusCode).toBe(502);
    expect(ec2Mock.commandCalls(TerminateInstancesCommand)).toHaveLength(0);
    expect(statusUpdates()).toHaveLength(0);
    // 拒否票だけは先に立ててある（生き残ったワーカーに`done`を書かせないため。
    // 停止を再実行できるようにするうえでも、この票が残っていて困ることはない）。
    expect(stopRequestedMarkers()).toHaveLength(1);
  });

  it("terminateが失敗したらfailedへの確定を行わない(止まっていないのに終了扱いにしない)", async () => {
    ddbMock.on(GetCommand).resolves({ Item: recordingJob });
    sfnMock.on(StopExecutionCommand).resolves({});
    ec2Mock.on(TerminateInstancesCommand).rejects(new Error("RequestLimitExceeded"));

    const res = await invoke("job-1");

    expect(res.statusCode).toBe(502);
    expect(statusUpdates()).toHaveLength(0);
  });

  it("拒否票の記録に失敗したら停止処理へ進まない", async () => {
    // 拒否票を立てられないまま自宅ワーカーの割り当てを解除すると、claimの取り消しに
    // 気づく前に完走したコンテナが`done`を書き、停止したはずのジョブの完了メールが
    // ユーザーへ飛ぶ。黙らせられないなら停止したことにしてはいけない。
    ddbMock.on(GetCommand).resolves({ Item: recordingJob });
    ddbMock.on(UpdateCommand).rejects(new Error("throttled"));

    const res = await invoke("job-1");

    expect(res.statusCode).toBe(502);
    expect((JSON.parse(res.body ?? "{}") as ApiError).code).toBe("mark_stop_requested_failed");
    expect(sfnMock.commandCalls(StopExecutionCommand)).toHaveLength(0);
    expect(ec2Mock.commandCalls(TerminateInstancesCommand)).toHaveLength(0);
    expect(statusUpdates()).toHaveLength(0);
  });

  it("ジョブが存在しなければ404を返す", async () => {
    ddbMock.on(GetCommand).resolves({});
    expect((await invoke("job-x")).statusCode).toBe(404);
  });

  it("jobIdが無ければ400を返す", async () => {
    expect((await invoke()).statusCode).toBe(400);
  });
});
