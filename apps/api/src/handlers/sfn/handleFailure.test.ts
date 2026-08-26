import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import {
  DescribeInstancesCommand,
  EC2Client,
  TerminateInstancesCommand,
} from "@aws-sdk/client-ec2";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import type { JobRecord } from "@sattori/shared";
import { MAX_ATTEMPTS, MAX_ATTEMPTS_DETERMINISTIC } from "../../retryPolicy.js";

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
  SETTINGS_TABLE: "sattori-settings",
  WORKERS_TABLE: "sattori-workers",
  SES_FROM_ADDRESS: "no-reply@sattori.hakatashi.com",
  SES_REPLY_TO_ADDRESS: "reply@example.com",
  SES_CONFIGURATION_SET: "sattori-config-set",
  WEB_BASE_URL: "https://sattori.hakatashi.com",
  ANALYTICS_EVENTS_TABLE: "sattori-analytics-events",
};

const ec2Mock = mockClient(EC2Client);
const ddbMock = mockClient(DynamoDBDocumentClient);

const baseJob: JobRecord = {
  jobId: "job-1",
  game: "th07",
  replayKey: "replays/abc.rpy",
  status: "launching",
  options: { watermark: true, slowMotion: false },
  outputPath: null,
  outputPath720p: null,
  error: null,
  errorCode: null,
  createdAt: "2026-07-17T00:00:00.000Z",
  updatedAt: "2026-07-17T00:00:00.000Z",
  doneAt: null,
  email: null,
  instanceId: "i-abc123",
  workerKind: null,
  instanceType: "c7i.xlarge",
  availabilityZone: "us-east-1a",
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
  desyncDetected: null,
};

/** statusを書き換えるUpdateItem（`SET #s = ...`）だけを取り出す。 */
function statusUpdates(mock: typeof ddbMock) {
  return mock
    .commandCalls(UpdateCommand)
    .filter((call) => call.args[0].input.ExpressionAttributeValues?.[":s"] !== undefined);
}

/** `TerminateInstances` に渡されたインスタンスIDを呼び出し順に並べる。 */
function terminatedIds(): string[] {
  return ec2Mock
    .commandCalls(TerminateInstancesCommand)
    .flatMap((call) => call.args[0].input.InstanceIds ?? []);
}

/** 自宅ワーカーの割り当て解除（`REMOVE assignedWorkerId ...`）のUpdateItemだけを取り出す。 */
function releaseUpdates(mock: typeof ddbMock) {
  return mock
    .commandCalls(UpdateCommand)
    .filter((call) => call.args[0].input.UpdateExpression?.includes("assignedWorkerId"));
}

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
    // 自宅ワーカー(Issue #49)の割り当て解除だけは毎回走る。statusは書き換えない。
    expect(statusUpdates(ddbMock)).toHaveLength(0);
    expect(releaseUpdates(ddbMock)).toHaveLength(1);
  });

  it("attemptが上限に達したらジョブをfailedにする", async () => {
    ddbMock.on(GetCommand).resolves({ Item: baseJob });
    ec2Mock.on(TerminateInstancesCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({});

    const { handler } = await import("./handleFailure.js");
    const result = await handler({ jobId: "job-1", attempt: MAX_ATTEMPTS });

    expect(result).toEqual({ shouldRetry: false });
    expect(statusUpdates(ddbMock)[0]?.args[0].input.ExpressionAttributeValues).toMatchObject({
      ":s": "failed",
      ":ec": "retries_exhausted",
    });
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
    expect(statusUpdates(ddbMock)).toHaveLength(0);
  });

  it("自宅ワーカー(Issue #49)への割り当てとオファーを解除する", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { ...baseJob, instanceId: null, workerKind: "home", assignedWorkerId: "home-1" },
    });

    const { handler } = await import("./handleFailure.js");
    await handler({ jobId: "job-1", attempt: 1 });

    // `assignedWorkerId`が消えることが、走っているデーモンへのclaim取り消しの合図。
    expect(releaseUpdates(ddbMock)[0]?.args[0].input.UpdateExpression).toContain(
      "REMOVE assignedWorkerId",
    );
  });

  it("割り当て解除に失敗してもリトライ判定は続ける", async () => {
    ddbMock.on(GetCommand).resolves({ Item: baseJob });
    ddbMock.on(UpdateCommand).rejects(new Error("throttled"));
    ec2Mock.on(TerminateInstancesCommand).resolves({});

    const { handler } = await import("./handleFailure.js");
    await expect(handler({ jobId: "job-1", attempt: 1 })).resolves.toEqual({ shouldRetry: true });
  });

  it("instanceIdが無くタグからも見つからなければterminateを呼ばない", async () => {
    ddbMock.on(GetCommand).resolves({ Item: { ...baseJob, instanceId: null } });
    ec2Mock.on(DescribeInstancesCommand).resolves({});

    const { handler } = await import("./handleFailure.js");
    await handler({ jobId: "job-1", attempt: 1 });

    expect(ec2Mock.commandCalls(TerminateInstancesCommand)).toHaveLength(0);
  });

  it("instanceIdが未記録でもタグ(sattori:jobId)から見つけたインスタンスをterminateする", async () => {
    // Launchが`CreateFleet`の後・instanceId書き込みの前に死んだケース(Issue #23)。
    // レコードには何も残らないので、タグから引けないと孤児が課金され続ける。
    ddbMock.on(GetCommand).resolves({ Item: { ...baseJob, instanceId: null } });
    ec2Mock.on(DescribeInstancesCommand).resolves({
      Reservations: [{ Instances: [{ InstanceId: "i-untracked" }] }],
    });
    ec2Mock.on(TerminateInstancesCommand).resolves({});

    const { handler } = await import("./handleFailure.js");
    await handler({ jobId: "job-1", attempt: 1 });

    expect(terminatedIds()).toEqual(["i-untracked"]);
  });

  it("記録済みinstanceIdとタグ由来のインスタンスをまとめて重複なくterminateする", async () => {
    ddbMock.on(GetCommand).resolves({ Item: baseJob });
    ec2Mock.on(DescribeInstancesCommand).resolves({
      Reservations: [
        { Instances: [{ InstanceId: "i-abc123" }, { InstanceId: "i-previous-attempt" }] },
      ],
    });
    ec2Mock.on(TerminateInstancesCommand).resolves({});

    const { handler } = await import("./handleFailure.js");
    await handler({ jobId: "job-1", attempt: 1 });

    expect(terminatedIds()).toEqual(["i-abc123", "i-previous-attempt"]);
  });

  it("タグ検索が失敗しても記録済みinstanceIdのterminateは続ける", async () => {
    ddbMock.on(GetCommand).resolves({ Item: baseJob });
    ec2Mock.on(DescribeInstancesCommand).rejects(new Error("throttled"));
    ec2Mock.on(TerminateInstancesCommand).resolves({});

    const { handler } = await import("./handleFailure.js");
    const result = await handler({ jobId: "job-1", attempt: 1 });

    expect(result).toEqual({ shouldRetry: true });
    expect(terminatedIds()).toEqual(["i-abc123"]);
  });

  // Issue #129: 後始末（terminate・割り当て解除）の間にワーカーが完走して`done`を
  // 書いた場合、スナップショット時点の`job.status`だけでは検知できない。最終的な
  // `failed`書き込みは`unlessDone`の原子的更新にし、書き込み時点の競合で防ぐ。
  it("最終failed書き込みはunlessDoneの条件付き更新で行う", async () => {
    ddbMock.on(GetCommand).resolves({ Item: baseJob });
    ec2Mock.on(TerminateInstancesCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({});

    const { handler } = await import("./handleFailure.js");
    await handler({ jobId: "job-1", attempt: MAX_ATTEMPTS });

    const failedUpdate = statusUpdates(ddbMock)[0];
    expect(failedUpdate?.args[0].input.ExpressionAttributeValues).toMatchObject({
      ":s": "failed",
      ":done": "done",
    });
    expect(failedUpdate?.args[0].input.ConditionExpression).toBe("#s <> :done");
  });

  it("後始末の間にdoneへ確定していた場合、条件付き更新が弾かれても例外にしない", async () => {
    ddbMock.on(GetCommand).resolves({ Item: baseJob });
    ec2Mock.on(TerminateInstancesCommand).resolves({});
    ddbMock
      .on(UpdateCommand)
      .resolvesOnce({}) // 自宅ワーカー割り当て解除
      .rejects(new ConditionalCheckFailedException({ message: "conditional", $metadata: {} }));

    const { handler } = await import("./handleFailure.js");
    await expect(
      handler({ jobId: "job-1", attempt: MAX_ATTEMPTS }),
    ).resolves.toEqual({ shouldRetry: false });
  });

  // 最終`failed`書き込みの例外はもう握りつぶさない。ジョブレコードを非終端のまま
  // 放置するより、ステートマシン側のLambda呼び出しリトライ(`handleFailureTask.addRetry`)
  // に委ねたほうが安全なため（Issue #129）。
  it("最終failed書き込みが(条件チェック以外の理由で)失敗したら例外を投げる", async () => {
    ddbMock.on(GetCommand).resolves({ Item: baseJob });
    ec2Mock.on(TerminateInstancesCommand).resolves({});
    ddbMock
      .on(UpdateCommand)
      .resolvesOnce({}) // 自宅ワーカー割り当て解除
      .rejects(new Error("ddb throttled"));

    const { handler } = await import("./handleFailure.js");
    await expect(handler({ jobId: "job-1", attempt: MAX_ATTEMPTS })).rejects.toThrow(
      "ddb throttled",
    );
  });

  // Issue #131: デシンク等が原因の失敗は同一リプレイなら毎回同じ箇所で再現するため、
  // `WorkerFailed`（Spot中断を除く）・`WorkerBootstrapFailure`は短い上限で打ち切る。
  describe("失敗種別によるリトライ上限の分岐(Issue #131)", () => {
    it("WorkerFailedはMAX_ATTEMPTS_DETERMINISTICで打ち切る", async () => {
      ddbMock.on(GetCommand).resolves({ Item: baseJob });
      ec2Mock.on(TerminateInstancesCommand).resolves({});
      ddbMock.on(UpdateCommand).resolves({});

      const { handler } = await import("./handleFailure.js");
      const result = await handler({
        jobId: "job-1",
        attempt: MAX_ATTEMPTS_DETERMINISTIC,
        error: { Error: "WorkerFailed", Cause: "th20: 検出タイムアウト" },
      });

      expect(result).toEqual({ shouldRetry: false });
      expect(statusUpdates(ddbMock)[0]?.args[0].input.ExpressionAttributeValues).toMatchObject({
        ":s": "failed",
      });
    });

    it("WorkerFailedでもattemptがMAX_ATTEMPTS_DETERMINISTIC未満ならリトライする", async () => {
      ddbMock.on(GetCommand).resolves({ Item: baseJob });
      ec2Mock.on(TerminateInstancesCommand).resolves({});

      const { handler } = await import("./handleFailure.js");
      const result = await handler({
        jobId: "job-1",
        attempt: MAX_ATTEMPTS_DETERMINISTIC - 1,
        error: { Error: "WorkerFailed", Cause: "th20: 検出タイムアウト" },
      });

      expect(result).toEqual({ shouldRetry: true });
    });

    it("WorkerBootstrapFailureはMAX_ATTEMPTS_DETERMINISTICで打ち切る", async () => {
      ddbMock.on(GetCommand).resolves({ Item: baseJob });
      ec2Mock.on(TerminateInstancesCommand).resolves({});
      ddbMock.on(UpdateCommand).resolves({});

      const { handler } = await import("./handleFailure.js");
      const result = await handler({
        jobId: "job-1",
        attempt: MAX_ATTEMPTS_DETERMINISTIC,
        error: { Error: "WorkerBootstrapFailure", Cause: "ECR login failed after 3 attempts" },
      });

      expect(result).toEqual({ shouldRetry: false });
    });

    it("Spot中断由来のWorkerFailed(CauseがSpotInterrupted:接頭辞)は通常のMAX_ATTEMPTSまでリトライする", async () => {
      ddbMock.on(GetCommand).resolves({ Item: baseJob });
      ec2Mock.on(TerminateInstancesCommand).resolves({});

      const { handler } = await import("./handleFailure.js");
      const result = await handler({
        jobId: "job-1",
        attempt: MAX_ATTEMPTS_DETERMINISTIC,
        error: { Error: "WorkerFailed", Cause: "SpotInterrupted: spot_interruption terminate" },
      });

      expect(result).toEqual({ shouldRetry: true });
    });

    it("States.Timeout等それ以外の失敗種別は通常のMAX_ATTEMPTSまでリトライする", async () => {
      ddbMock.on(GetCommand).resolves({ Item: baseJob });
      ec2Mock.on(TerminateInstancesCommand).resolves({});

      const { handler } = await import("./handleFailure.js");
      const result = await handler({
        jobId: "job-1",
        attempt: MAX_ATTEMPTS_DETERMINISTIC,
        error: { Error: "States.Timeout", Cause: "State's Task did not complete" },
      });

      expect(result).toEqual({ shouldRetry: true });
    });

    // Issue #160: ホストは正常なのにコンテナだけ通信不能という障害を自宅ワーカー側の
    // 疎通確認(home-worker/src/daemon.ts)で未然に防げなかった場合の保険。同じ自宅
    // ワーカーへ即座に再試行しても結果は変わらないため、WorkerBootstrapFailureと
    // 同様に早期打ち切りの対象にする。
    it("HomeWorkerContainerFailed(Issue #160)はMAX_ATTEMPTS_DETERMINISTICで打ち切る", async () => {
      ddbMock.on(GetCommand).resolves({ Item: baseJob });
      ec2Mock.on(TerminateInstancesCommand).resolves({});
      ddbMock.on(UpdateCommand).resolves({});

      const { handler } = await import("./handleFailure.js");
      const result = await handler({
        jobId: "job-1",
        attempt: MAX_ATTEMPTS_DETERMINISTIC,
        error: { Error: "HomeWorkerContainerFailed", Cause: "container exited with 1" },
      });

      expect(result).toEqual({ shouldRetry: false });
    });

    it("HomeWorkerContainerFailedでもattemptがMAX_ATTEMPTS_DETERMINISTIC未満ならリトライする", async () => {
      ddbMock.on(GetCommand).resolves({ Item: baseJob });
      ec2Mock.on(TerminateInstancesCommand).resolves({});

      const { handler } = await import("./handleFailure.js");
      const result = await handler({
        jobId: "job-1",
        attempt: MAX_ATTEMPTS_DETERMINISTIC - 1,
        error: { Error: "HomeWorkerContainerFailed", Cause: "container exited with 1" },
      });

      expect(result).toEqual({ shouldRetry: true });
    });

    it("errorが渡されない場合(後方互換)は通常のMAX_ATTEMPTSまでリトライする", async () => {
      ddbMock.on(GetCommand).resolves({ Item: baseJob });
      ec2Mock.on(TerminateInstancesCommand).resolves({});

      const { handler } = await import("./handleFailure.js");
      const result = await handler({ jobId: "job-1", attempt: MAX_ATTEMPTS_DETERMINISTIC });

      expect(result).toEqual({ shouldRetry: true });
    });
  });
});
