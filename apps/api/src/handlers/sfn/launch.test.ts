import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CreateFleetCommand,
  CreateLaunchTemplateVersionCommand,
  DescribeSpotPriceHistoryCommand,
  EC2Client,
} from "@aws-sdk/client-ec2";
import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import type { JobRecord, WorkerHeartbeat } from "@sattori/shared";

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
  SES_REPLY_TO_ADDRESS: "hakatasiloving@gmail.com",
  SES_CONFIGURATION_SET: "sattori-config-set",
  WEB_BASE_URL: "https://sattori.hakatashi.com",
};

const ec2Mock = mockClient(EC2Client);
const ddbMock = mockClient(DynamoDBDocumentClient);

const job: JobRecord = {
  jobId: "job-1",
  game: "th07",
  replayKey: "replays/abc.rpy",
  status: "queued",
  options: { watermark: true, slowMotion: false },
  outputPath: null,
  outputPath720p: null,
  outputBytes: null,
  outputBytes720p: null,
  error: null,
  errorCode: null,
  createdAt: "2026-07-17T00:00:00.000Z",
  updatedAt: "2026-07-17T00:00:00.000Z",
  launchedAt: null,
  doneAt: null,
  email: null,
  instanceId: null,
  workerKind: null,
  instanceType: null,
  availabilityZone: null,
  spotPricePerHour: null,
  estimatedDurationSeconds: 900,
  progress: null,
  previewImagePath: null,
  replayInfo: null,
  pendingExpiresAt: null,
  retriedToJobId: null,
  retriedFromJobId: null,
  language: "ja",
};

/** 空き十分・対応タイトルありの自宅ワーカー（Issue #49）。 */
function heartbeat(overrides: Partial<WorkerHeartbeat> = {}): WorkerHeartbeat {
  return {
    workerId: "home-1",
    kind: "home",
    lastHeartbeatAt: new Date().toISOString(),
    accepting: true,
    activeJobs: 0,
    maxConcurrency: 4,
    supportedGames: ["th07"],
    capabilities: [],
    ttl: Math.floor(Date.now() / 1000) + 900,
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubEnv("JOBS_TABLE", REQUIRED_ENV.JOBS_TABLE!);
  for (const [key, value] of Object.entries(REQUIRED_ENV)) {
    vi.stubEnv(key, value);
  }
  ec2Mock.reset();
  ddbMock.reset();
  // 既定では自宅ワーカーは1台も動いていない（＝従来どおりEC2 Fleetを起動する）。
  ddbMock.on(ScanCommand).resolves({ Items: [] });
});

describe("sfn/launch handler", () => {
  it("ジョブを取得しEC2 Fleetで起動、status・インスタンス情報・launchedAtを更新する", async () => {
    ddbMock.on(GetCommand).resolves({ Item: job });
    ec2Mock
      .on(CreateLaunchTemplateVersionCommand)
      .resolves({ LaunchTemplateVersion: { VersionNumber: 2 } });
    ec2Mock.on(CreateFleetCommand).resolves({
      Instances: [
        {
          InstanceIds: ["i-abc123"],
          InstanceType: "c7i.xlarge",
          AvailabilityZone: "us-east-1a",
        },
      ],
    });
    ec2Mock.on(DescribeSpotPriceHistoryCommand).resolves({
      SpotPriceHistory: [{ SpotPrice: "0.0583" }],
    });
    ddbMock.on(UpdateCommand).resolves({});

    const { handler } = await import("./launch.js");
    await handler({ jobId: "job-1", attempt: 1, taskToken: "token-xyz" });

    expect(ec2Mock.commandCalls(CreateFleetCommand)).toHaveLength(1);
    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls.length).toBe(4);
    const updatedFields = updateCalls.map((call) => call.args[0].input.ExpressionAttributeValues);
    expect(updatedFields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ":s": "launching" }),
        expect.objectContaining({
          ":i": "i-abc123",
          ":t": "c7i.xlarge",
          ":az": "us-east-1a",
          ":sp": 0.0583,
        }),
        // launchedAt（コスト推定の課金起点、Issue #60）は未設定のときだけ書き込む。
        expect.objectContaining({ ":nullType": "NULL" }),
        // 誰が実行しているか（Issue #49）。コスト推定がこの値で分岐する。
        expect.objectContaining({ ":w": "ec2" }),
      ]),
    );
  });

  it("Spot単価が取得できなくても起動は続行しnullで記録する", async () => {
    ddbMock.on(GetCommand).resolves({ Item: job });
    ec2Mock
      .on(CreateLaunchTemplateVersionCommand)
      .resolves({ LaunchTemplateVersion: { VersionNumber: 2 } });
    ec2Mock.on(CreateFleetCommand).resolves({
      Instances: [{ InstanceIds: ["i-abc123"], InstanceType: "c7i.xlarge", AvailabilityZone: "us-east-1a" }],
    });
    ec2Mock.on(DescribeSpotPriceHistoryCommand).rejects(new Error("throttled"));
    ddbMock.on(UpdateCommand).resolves({});

    const { handler } = await import("./launch.js");
    await handler({ jobId: "job-1", attempt: 1, taskToken: "token-xyz" });

    const updatedFields = ddbMock
      .commandCalls(UpdateCommand)
      .map((call) => call.args[0].input.ExpressionAttributeValues);
    expect(updatedFields).toEqual(
      expect.arrayContaining([expect.objectContaining({ ":i": "i-abc123", ":sp": null })]),
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

describe("sfn/launch handler（自宅ワーカーへのオファー、Issue #49）", () => {
  /** オファー用UpdateItem（`homeWorkerOfferState`をSETするもの）。 */
  const offerCalls = () =>
    ddbMock
      .commandCalls(UpdateCommand)
      .filter((call) => call.args[0].input.UpdateExpression?.includes("SET homeWorkerOfferState"));

  /** オファー撤回のUpdateItem。 */
  const withdrawCalls = () =>
    ddbMock
      .commandCalls(UpdateCommand)
      .filter((call) => call.args[0].input.UpdateExpression?.startsWith("REMOVE homeWorkerOfferState"));

  it("ハートビートが無ければオファーせず即EC2を起動する（平常時に遅延させない）", async () => {
    ddbMock.on(GetCommand).resolves({ Item: job });
    ddbMock.on(UpdateCommand).resolves({});
    ec2Mock
      .on(CreateLaunchTemplateVersionCommand)
      .resolves({ LaunchTemplateVersion: { VersionNumber: 2 } });
    ec2Mock.on(CreateFleetCommand).resolves({
      Instances: [{ InstanceIds: ["i-abc123"], InstanceType: "c7i.xlarge", AvailabilityZone: "eu-south-2a" }],
    });
    ec2Mock.on(DescribeSpotPriceHistoryCommand).resolves({ SpotPriceHistory: [] });

    const { handler } = await import("./launch.js");
    await handler({ jobId: "job-1", attempt: 1, taskToken: "token-xyz" });

    expect(offerCalls()).toHaveLength(0);
    expect(ec2Mock.commandCalls(CreateFleetCommand)).toHaveLength(1);
  });

  it("claimされたらEC2を起動しない（taskTokenはデーモンが持つ）", async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [heartbeat()] });
    // 1回目=Launch冒頭のジョブ取得、2回目以降=claim確認。すぐclaimされた状況にする。
    ddbMock
      .on(GetCommand)
      .resolvesOnce({ Item: job })
      .resolves({ Item: { assignedWorkerId: "home-1" } });
    ddbMock.on(UpdateCommand).resolves({});

    const { handler } = await import("./launch.js");
    await handler({ jobId: "job-1", attempt: 1, taskToken: "token-xyz" });

    expect(ec2Mock.commandCalls(CreateFleetCommand)).toHaveLength(0);
    // オファーにはワーカーコンテナの環境変数一式（taskToken含む）を添える。
    const env = offerCalls()[0]?.args[0].input.ExpressionAttributeValues?.[":env"];
    expect(env).toMatchObject({ JOB_ID: "job-1", GAME: "th07", TASK_TOKEN: "token-xyz" });
    // statusの更新はデーモンがclaimと同じ条件付き更新で行うため、ここでは書かない
    // （後追いで書くと、先に走り出したコンテナのrecordingを上書きしうる）。
    const statusValues = ddbMock
      .commandCalls(UpdateCommand)
      .map((call) => call.args[0].input.ExpressionAttributeValues?.[":s"]);
    expect(statusValues).not.toContain("launching");
  });

  it("時間内にclaimされなければオファーを撤回してEC2へフォールバックする", async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [heartbeat()] });
    ddbMock.on(GetCommand).resolvesOnce({ Item: job }).resolves({ Item: {} });
    ddbMock.on(UpdateCommand).resolves({});
    ec2Mock
      .on(CreateLaunchTemplateVersionCommand)
      .resolves({ LaunchTemplateVersion: { VersionNumber: 2 } });
    ec2Mock.on(CreateFleetCommand).resolves({
      Instances: [{ InstanceIds: ["i-abc123"], InstanceType: "c7i.xlarge", AvailabilityZone: "eu-south-2a" }],
    });
    ec2Mock.on(DescribeSpotPriceHistoryCommand).resolves({ SpotPriceHistory: [] });

    const { handler } = await import("./launch.js");
    // 実時間で待たないよう、オファー期限を即座に過ぎた状態にする。
    vi.useFakeTimers();
    try {
      const promise = handler({ jobId: "job-1", attempt: 1, taskToken: "token-xyz" });
      await vi.advanceTimersByTimeAsync(60_000);
      await promise;
    } finally {
      vi.useRealTimers();
    }

    expect(withdrawCalls()).toHaveLength(1);
    expect(ec2Mock.commandCalls(CreateFleetCommand)).toHaveLength(1);
  });

  it("撤回の直前にclaimされていたらEC2を起動しない（二重録画の防止）", async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [heartbeat()] });
    ddbMock.on(GetCommand).resolvesOnce({ Item: job }).resolves({ Item: {} });
    ddbMock.on(UpdateCommand).resolves({});
    // 撤回だけが条件チェックで失敗する＝待機中にclaimされていた。
    ddbMock
      .on(UpdateCommand, { ConditionExpression: "attribute_not_exists(assignedWorkerId)" })
      .callsFake((input: { UpdateExpression?: string }) => {
        if (input.UpdateExpression?.startsWith("REMOVE")) {
          throw new ConditionalCheckFailedException({ message: "claimed", $metadata: {} });
        }
        return {};
      });

    const { handler } = await import("./launch.js");
    vi.useFakeTimers();
    try {
      const promise = handler({ jobId: "job-1", attempt: 1, taskToken: "token-xyz" });
      await vi.advanceTimersByTimeAsync(60_000);
      await promise;
    } finally {
      vi.useRealTimers();
    }

    expect(ec2Mock.commandCalls(CreateFleetCommand)).toHaveLength(0);
  });

  it("オファーが書けず、レコードのtaskTokenが今回のものならEC2を起動しない", async () => {
    // Launchの再入で、今回のトークンを持つデーモンが既に走っている状況。
    ddbMock.on(ScanCommand).resolves({ Items: [heartbeat()] });
    ddbMock
      .on(GetCommand)
      .resolvesOnce({ Item: job })
      .resolves({
        Item: { assignedWorkerId: "home-1", homeWorkerEnv: { TASK_TOKEN: "token-xyz" } },
      });
    ddbMock
      .on(UpdateCommand)
      .rejects(new ConditionalCheckFailedException({ message: "claimed", $metadata: {} }));

    const { handler } = await import("./launch.js");
    await handler({ jobId: "job-1", attempt: 2, taskToken: "token-xyz" });

    expect(ec2Mock.commandCalls(CreateFleetCommand)).toHaveLength(0);
  });

  it("オファーが書けず、残っていたのが前の試行の割り当てなら解除してEC2を起動する", async () => {
    // `HandleFailure` の割り当て解除が一時障害で失敗すると、陳腐化した
    // `assignedWorkerId` が残る。これをclaim済みと誤読すると、今回のtaskTokenを
    // 誰も持たないまま15分のタイムアウトを待つ（リトライ1周が丸ごと無駄になる）。
    ddbMock.on(ScanCommand).resolves({ Items: [heartbeat()] });
    ddbMock
      .on(GetCommand)
      .resolvesOnce({ Item: job })
      .resolves({
        // 前の試行のトークンが残っている（今回のトークンは誰も持っていない）。
        Item: { assignedWorkerId: "home-1", homeWorkerEnv: { TASK_TOKEN: "token-old" } },
      });
    ddbMock.on(UpdateCommand).resolves({});
    // オファーの書き込み（未claimを条件にする更新）だけが条件チェックで失敗する。
    ddbMock
      .on(UpdateCommand, { ConditionExpression: "attribute_not_exists(assignedWorkerId)" })
      .rejects(new ConditionalCheckFailedException({ message: "stale", $metadata: {} }));
    ec2Mock
      .on(CreateLaunchTemplateVersionCommand)
      .resolves({ LaunchTemplateVersion: { VersionNumber: 2 } });
    ec2Mock.on(CreateFleetCommand).resolves({
      Instances: [{ InstanceIds: ["i-abc123"], InstanceType: "c7i.xlarge", AvailabilityZone: "eu-south-2a" }],
    });
    ec2Mock.on(DescribeSpotPriceHistoryCommand).resolves({ SpotPriceHistory: [] });

    const { handler } = await import("./launch.js");
    await handler({ jobId: "job-1", attempt: 2, taskToken: "token-xyz" });

    // 陳腐化した割り当てを解除してからEC2へフォールバックする（解除は走っている
    // 古いコンテナを止める手段も兼ねる）。
    const releaseCalls = ddbMock
      .commandCalls(UpdateCommand)
      .filter((call) => call.args[0].input.UpdateExpression?.includes("REMOVE assignedWorkerId"));
    expect(releaseCalls).toHaveLength(1);
    expect(ec2Mock.commandCalls(CreateFleetCommand)).toHaveLength(1);
  });

  it("ハートビートの読み取りに失敗してもEC2起動へフォールバックする", async () => {
    ddbMock.on(ScanCommand).rejects(new Error("throttled"));
    ddbMock.on(GetCommand).resolves({ Item: job });
    ddbMock.on(UpdateCommand).resolves({});
    ec2Mock
      .on(CreateLaunchTemplateVersionCommand)
      .resolves({ LaunchTemplateVersion: { VersionNumber: 2 } });
    ec2Mock.on(CreateFleetCommand).resolves({
      Instances: [{ InstanceIds: ["i-abc123"], InstanceType: "c7i.xlarge", AvailabilityZone: "eu-south-2a" }],
    });
    ec2Mock.on(DescribeSpotPriceHistoryCommand).resolves({ SpotPriceHistory: [] });

    const { handler } = await import("./launch.js");
    await handler({ jobId: "job-1", attempt: 1, taskToken: "token-xyz" });

    expect(offerCalls()).toHaveLength(0);
    expect(ec2Mock.commandCalls(CreateFleetCommand)).toHaveLength(1);
  });
});
