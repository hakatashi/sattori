import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CreateFleetCommand,
  type CreateFleetCommandInput,
  CreateLaunchTemplateVersionCommand,
  DescribeSpotPriceHistoryCommand,
  DescribeSubnetsCommand,
  EC2Client,
} from "@aws-sdk/client-ec2";
import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import type { JobRecord, WorkerHeartbeat } from "@sattori/shared";
import { createJobRecord } from "../../testSupport/jobRecord.js";

const REQUIRED_ENV: Record<string, string> = {
  UPLOAD_BUCKET: "up-bucket",
  OUTPUT_BUCKET: "out-bucket",
  CDN_DOMAIN: "cdn.example.net",
  JOBS_TABLE: "sattori-jobs",
  WORKER_IMAGE: "123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/sattori-worker:latest",
  WORKER_GPU_IMAGE: "123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/sattori-worker-gpu:latest",
  TITLE_ASSETS_BUCKET: "title-assets-bucket",
  WORKER_LOG_GROUP: "/sattori/worker",
  WORKER_SUBNET_IDS: "subnet-aaaa,subnet-bbbb",
  WORKER_LAUNCH_TEMPLATE_ID: "lt-xxxx",
  GPU_WORKER_LAUNCH_TEMPLATE_ID: "lt-gpu-xxxx",
  EMAIL_RATE_LIMIT_TABLE: "email-rate-limit",
  SETTINGS_TABLE: "sattori-settings",
  WORKERS_TABLE: "sattori-workers",
  SES_FROM_ADDRESS: "no-reply@sattori.hakatashi.com",
  SES_REPLY_TO_ADDRESS: "reply@example.com",
  SES_CONFIGURATION_SET: "sattori-config-set",
  WEB_BASE_URL: "https://sattori.hakatashi.com",
  ANALYTICS_EVENTS_TABLE: "sattori-analytics-events",
  GPU_SLOTS_TABLE: "sattori-gpu-slots",
};

const ec2Mock = mockClient(EC2Client);
const ddbMock = mockClient(DynamoDBDocumentClient);

const job: JobRecord = createJobRecord({
  status: "queued",
  createdAt: "2026-07-17T00:00:00.000Z",
  updatedAt: "2026-07-17T00:00:00.000Z",
  email: null,
  pendingExpiresAt: null,
});

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

afterEach(() => {
  vi.unstubAllEnvs();
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

describe("sfn/launch handler（GPU vCPU容量リース、Issue #270）", () => {
  const gpuJob: JobRecord = createJobRecord({
    game: "th15",
    status: "queued",
    createdAt: "2026-07-17T00:00:00.000Z",
    updatedAt: "2026-07-17T00:00:00.000Z",
    email: null,
    pendingExpiresAt: null,
  });

  function gpuLeaseItem(vcpu: number) {
    return {
      slotKey: "gpu",
      itemKey: "job#job-1",
      jobId: "job-1",
      vcpu,
      acquiredAt: "2026-07-17T00:00:00.000Z",
      expiresAt: "2026-07-17T03:00:00.000Z",
      expectedFinishAt: "2026-07-17T00:30:00.000Z",
    };
  }

  it("GPUジョブは自分のリースを読みvCPU上限に応じて候補タイプを絞る", async () => {
    ddbMock.on(GetCommand, { TableName: REQUIRED_ENV.JOBS_TABLE }).resolves({ Item: gpuJob });
    ddbMock
      .on(GetCommand, { TableName: REQUIRED_ENV.GPU_SLOTS_TABLE })
      .resolves({ Item: gpuLeaseItem(8) });
    ddbMock.on(UpdateCommand).resolves({});
    ddbMock.on(TransactWriteCommand).resolves({});
    ec2Mock
      .on(CreateLaunchTemplateVersionCommand)
      .resolves({ LaunchTemplateVersion: { VersionNumber: 2 } });
    ec2Mock.on(CreateFleetCommand).resolves({
      Instances: [{ InstanceIds: ["i-gpu"], InstanceType: "g6f.2xlarge", AvailabilityZone: "eu-south-2b" }],
    });
    ec2Mock.on(DescribeSpotPriceHistoryCommand).resolves({ SpotPriceHistory: [] });

    const { handler } = await import("./launch.js");
    await handler({ jobId: "job-1", attempt: 1, taskToken: "token-xyz" });

    const overrides =
      ec2Mock.commandCalls(CreateFleetCommand)[0]?.args[0].input.LaunchTemplateConfigs?.[0]?.Overrides ?? [];
    const instanceTypes = new Set(overrides.map((o) => o.InstanceType));
    // 起動候補はg6f.2xlargeのみ(Issue #288)。
    expect(instanceTypes).toEqual(new Set(["g6f.2xlarge"]));
  });

  it("リースが確保できたvCPUより実際のインスタンスが小さければ縮小する", async () => {
    ddbMock.on(GetCommand, { TableName: REQUIRED_ENV.JOBS_TABLE }).resolves({ Item: gpuJob });
    ddbMock
      .on(GetCommand, { TableName: REQUIRED_ENV.GPU_SLOTS_TABLE })
      .resolves({ Item: gpuLeaseItem(8) });
    ddbMock.on(UpdateCommand).resolves({});
    ddbMock.on(TransactWriteCommand).resolves({});
    ec2Mock
      .on(CreateLaunchTemplateVersionCommand)
      .resolves({ LaunchTemplateVersion: { VersionNumber: 2 } });
    ec2Mock.on(CreateFleetCommand).resolves({
      Instances: [{ InstanceIds: ["i-gpu"], InstanceType: "g6f.xlarge", AvailabilityZone: "eu-south-2b" }],
    });
    ec2Mock.on(DescribeSpotPriceHistoryCommand).resolves({ SpotPriceHistory: [] });

    const { handler } = await import("./launch.js");
    await handler({ jobId: "job-1", attempt: 1, taskToken: "token-xyz" });

    const transactCalls = ddbMock.commandCalls(TransactWriteCommand);
    expect(transactCalls).toHaveLength(1);
    const leaseUpdate = transactCalls[0]?.args[0].input.TransactItems?.[0]?.Update;
    expect(leaseUpdate?.ExpressionAttributeValues?.[":old"]).toBe(8);
    expect(leaseUpdate?.ExpressionAttributeValues?.[":new"]).toBe(4);
  });

  it("実際のインスタンスタイプがリースのvCPUと一致すれば縮小しない", async () => {
    ddbMock.on(GetCommand, { TableName: REQUIRED_ENV.JOBS_TABLE }).resolves({ Item: gpuJob });
    ddbMock
      .on(GetCommand, { TableName: REQUIRED_ENV.GPU_SLOTS_TABLE })
      .resolves({ Item: gpuLeaseItem(8) });
    ddbMock.on(UpdateCommand).resolves({});
    ec2Mock
      .on(CreateLaunchTemplateVersionCommand)
      .resolves({ LaunchTemplateVersion: { VersionNumber: 2 } });
    ec2Mock.on(CreateFleetCommand).resolves({
      Instances: [{ InstanceIds: ["i-gpu"], InstanceType: "g6f.2xlarge", AvailabilityZone: "eu-south-2b" }],
    });
    ec2Mock.on(DescribeSpotPriceHistoryCommand).resolves({ SpotPriceHistory: [] });

    const { handler } = await import("./launch.js");
    await handler({ jobId: "job-1", attempt: 1, taskToken: "token-xyz" });

    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it("管理設定forceGpuFallbackRegionならフォールバック先で起動しworkerRegionを記録する（Issue #296）", async () => {
    vi.stubEnv("GPU_FALLBACK_REGION", "eu-north-1");
    vi.stubEnv("GPU_FALLBACK_LAUNCH_TEMPLATE_NAME", "sattori-gpu-worker");
    vi.stubEnv("GPU_FALLBACK_SUBNET_TAG_KEY", "sattori:gpuWorkerSubnet");
    vi.stubEnv(
      "GPU_FALLBACK_WORKER_GPU_IMAGE",
      "123456789012.dkr.ecr.eu-north-1.amazonaws.com/sattori-worker-gpu:latest",
    );
    vi.stubEnv("GPU_FALLBACK_OUTPUT_BUCKET", "sattori-output-123456789012-eu-north-1");
    vi.stubEnv("GPU_FALLBACK_TITLE_ASSETS_BUCKET", "sattori-title-assets-123456789012-eu-north-1");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    ddbMock.on(GetCommand, { TableName: REQUIRED_ENV.JOBS_TABLE }).resolves({ Item: gpuJob });
    ddbMock
      .on(GetCommand, { TableName: REQUIRED_ENV.GPU_SLOTS_TABLE })
      .resolves({ Item: gpuLeaseItem(8) });
    ddbMock
      .on(GetCommand, { TableName: REQUIRED_ENV.SETTINGS_TABLE })
      .resolves({ Item: { settingKey: "global", forceGpuFallbackRegion: true } });
    ddbMock.on(UpdateCommand).resolves({});
    ec2Mock
      .on(CreateLaunchTemplateVersionCommand)
      .resolves({ LaunchTemplateVersion: { VersionNumber: 2 } });
    ec2Mock.on(DescribeSubnetsCommand).resolves({ Subnets: [{ SubnetId: "subnet-north-b" }] });
    const fleetRegions: string[] = [];
    ec2Mock.on(CreateFleetCommand).callsFake(async (_input, getClient) => {
      fleetRegions.push(await getClient().config.region());
      return {
        Instances: [
          { InstanceIds: ["i-gpu"], InstanceType: "g6f.2xlarge", AvailabilityZone: "eu-north-1b" },
        ],
      };
    });
    ec2Mock.on(DescribeSpotPriceHistoryCommand).resolves({ SpotPriceHistory: [] });

    const { handler } = await import("./launch.js");
    await handler({ jobId: "job-1", attempt: 1, taskToken: "token-xyz" });

    expect(fleetRegions).toEqual(["eu-north-1"]);
    const instanceUpdate = ddbMock
      .commandCalls(UpdateCommand)
      .find((call) => call.args[0].input.UpdateExpression?.includes("workerRegion"));
    expect(instanceUpdate?.args[0].input.ExpressionAttributeValues?.[":r"]).toBe("eu-north-1");
    logSpy.mockRestore();
  });

  it("GPUジョブなのにリースが見つからなければ例外を投げる(Launchのcatchへ委ねる)", async () => {
    ddbMock.on(GetCommand, { TableName: REQUIRED_ENV.JOBS_TABLE }).resolves({ Item: gpuJob });
    ddbMock.on(GetCommand, { TableName: REQUIRED_ENV.GPU_SLOTS_TABLE }).resolves({});

    const { handler } = await import("./launch.js");
    await expect(
      handler({ jobId: "job-1", attempt: 1, taskToken: "token-xyz" }),
    ).rejects.toThrow(/vCPUリース/);
    expect(ec2Mock.commandCalls(CreateFleetCommand)).toHaveLength(0);
  });

  it("非GPUジョブはGpuSlotsTableに一切触れない", async () => {
    ddbMock.on(GetCommand, { TableName: REQUIRED_ENV.JOBS_TABLE }).resolves({ Item: job });
    ddbMock.on(UpdateCommand).resolves({});
    ec2Mock
      .on(CreateLaunchTemplateVersionCommand)
      .resolves({ LaunchTemplateVersion: { VersionNumber: 2 } });
    ec2Mock.on(CreateFleetCommand).resolves({
      Instances: [{ InstanceIds: ["i-cpu"], InstanceType: "c7i.xlarge", AvailabilityZone: "eu-south-2a" }],
    });
    ec2Mock.on(DescribeSpotPriceHistoryCommand).resolves({ SpotPriceHistory: [] });

    const { handler } = await import("./launch.js");
    await handler({ jobId: "job-1", attempt: 1, taskToken: "token-xyz" });

    expect(ddbMock.commandCalls(GetCommand, { TableName: REQUIRED_ENV.GPU_SLOTS_TABLE })).toHaveLength(0);
  });
});

describe("sfn/launch handler（全段の容量不足、Issue #315）", () => {
  const lease = {
    slotKey: "gpu",
    itemKey: "job#job-1",
    jobId: "job-1",
    vcpu: 8,
    acquiredAt: "a",
    expiresAt: "b",
    expectedFinishAt: "c",
  };
  /** 実際のCreateFleetと同じく、失敗した組み合わせごとに1件返す。 */
  function capacityFailure(input: CreateFleetCommandInput) {
    return {
      Instances: [],
      Errors: (input.LaunchTemplateConfigs?.[0]?.Overrides ?? []).map((override) => ({
        ErrorCode: "UnfulfillableCapacity",
        ErrorMessage: "no capacity",
        LaunchTemplateAndOverrides: { Overrides: override },
      })),
    };
  }

  function mockSpeedupJobStore(initial: JobRecord): void {
    // `fallBackToNativeSpeed`の書き込みを、後続の読み直しへ反映する。
    let current = initial;
    ddbMock.on(GetCommand, { TableName: REQUIRED_ENV.JOBS_TABLE }).callsFake(async () => ({ Item: current }));
    ddbMock.on(GetCommand, { TableName: REQUIRED_ENV.GPU_SLOTS_TABLE }).resolves({ Item: lease });
    ddbMock.on(TransactWriteCommand).resolves({});
    ddbMock.on(UpdateCommand).callsFake(async (input) => {
      if (String(input.UpdateExpression).includes("requestedRecordingSpeed")) {
        current = { ...current, options: { ...current.options, recordingSpeed: 1 } };
      }
      return {};
    });
    ec2Mock
      .on(CreateLaunchTemplateVersionCommand)
      .resolves({ LaunchTemplateVersion: { VersionNumber: 2 } });
    ec2Mock.on(DescribeSpotPriceHistoryCommand).resolves({ SpotPriceHistory: [] });
  }

  function updateExpressions(): string[] {
    return ddbMock.commandCalls(UpdateCommand).map((call) => String(call.args[0].input.UpdateExpression));
  }

  function statusValues() {
    return ddbMock
      .commandCalls(UpdateCommand)
      .map((call) => call.args[0].input.ExpressionAttributeValues)
      .filter((values) => values?.[":s"] !== undefined);
  }

  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  it("倍速録画はGPUの段を使い切ったら同じ呼び出しの中で等倍のCPU系へ起動し直し、リースを返却する", async () => {
    mockSpeedupJobStore({ ...job, options: { ...job.options, recordingSpeed: 2 } });
    ec2Mock
      .on(CreateFleetCommand)
      .callsFakeOnce(capacityFailure)
      .resolves({
        Instances: [{ InstanceIds: ["i-cpu"], InstanceType: "c7i.xlarge", AvailabilityZone: "a" }],
      });

    const { handler } = await import("./launch.js");
    await handler({ jobId: "job-1", attempt: 1, taskToken: "token-xyz" });

    const fleets = ec2Mock.commandCalls(CreateFleetCommand);
    expect(fleets).toHaveLength(2);
    expect(fleets[1]?.args[0].input.LaunchTemplateConfigs?.[0]?.LaunchTemplateSpecification?.LaunchTemplateId).toBe(
      "lt-xxxx",
    );
    expect(updateExpressions().some((e) => e.includes("capacityExhaustedTargets"))).toBe(true);
    expect(updateExpressions().some((e) => e.includes("requestedRecordingSpeed"))).toBe(true);
    expect(ddbMock.commandCalls(TransactWriteCommand).length).toBeGreaterThan(0);
    expect(statusValues()).toEqual([expect.objectContaining({ ":s": "launching" })]);
  });

  it("等倍へ落としたジョブは自宅ワーカーへオファーする", async () => {
    mockSpeedupJobStore({ ...job, options: { ...job.options, recordingSpeed: 2 } });
    ddbMock.on(ScanCommand).resolves({ Items: [heartbeat()] });
    ec2Mock.on(CreateFleetCommand).callsFake(capacityFailure);
    // オファーの書き込みと同時にclaimされた状態を返す。
    ddbMock.on(GetCommand, { TableName: REQUIRED_ENV.JOBS_TABLE }).callsFake(async (input) =>
      input.ProjectionExpression
        ? { Item: { assignedWorkerId: "home-1" } }
        : {
            Item: ddbMock
              .commandCalls(UpdateCommand)
              .some((call) => String(call.args[0].input.UpdateExpression).includes("requestedRecordingSpeed"))
              ? job
              : { ...job, options: { ...job.options, recordingSpeed: 2 } },
          },
    );

    const { handler } = await import("./launch.js");
    await handler({ jobId: "job-1", attempt: 1, taskToken: "token-xyz" });

    expect(ec2Mock.commandCalls(CreateFleetCommand)).toHaveLength(1);
    expect(updateExpressions().some((e) => e.includes("SET homeWorkerOfferState"))).toBe(true);
  });

  it("GPU必須タイトルは全段が容量不足ならcapacity_exhaustedで直ちに失敗させ、リースを返却して例外を投げる", async () => {
    mockSpeedupJobStore({ ...job, game: "th06nc" });
    ec2Mock.on(CreateFleetCommand).callsFake(capacityFailure);

    const { handler } = await import("./launch.js");
    const { LaunchTiersExhaustedError } = await import("../../ec2.js");
    await expect(
      handler({ jobId: "job-1", attempt: 1, taskToken: "token-xyz" }),
    ).rejects.toBeInstanceOf(LaunchTiersExhaustedError);

    expect(statusValues()).toEqual([
      expect.objectContaining({ ":s": "failed", ":ec": "capacity_exhausted", ":done": "done" }),
    ]);
    expect(ddbMock.commandCalls(TransactWriteCommand).length).toBeGreaterThan(0);
  });

  it("CPU系ジョブも全段が容量不足なら直ちに失敗させる", async () => {
    mockSpeedupJobStore(job);
    ec2Mock.on(CreateFleetCommand).callsFake(capacityFailure);

    const { handler } = await import("./launch.js");
    await expect(handler({ jobId: "job-1", attempt: 1, taskToken: "token-xyz" })).rejects.toThrow(
      /UnfulfillableCapacity/,
    );

    expect(statusValues()).toEqual([expect.objectContaining({ ":ec": "capacity_exhausted" })]);
  });

  it("前の試行でワーカーがfailedを書いたジョブ（リトライ中）も等倍へ落とせる条件で更新する", async () => {
    mockSpeedupJobStore({
      ...job,
      status: "failed",
      errorCode: "recording_failed",
      options: { ...job.options, recordingSpeed: 2 },
    });
    ec2Mock
      .on(CreateFleetCommand)
      .callsFakeOnce(capacityFailure)
      .resolves({
        Instances: [{ InstanceIds: ["i-cpu"], InstanceType: "c7i.xlarge", AvailabilityZone: "a" }],
      });

    const { handler } = await import("./launch.js");
    await handler({ jobId: "job-1", attempt: 2, taskToken: "token-xyz" });

    const fallback = ddbMock
      .commandCalls(UpdateCommand)
      .find((call) => String(call.args[0].input.UpdateExpression).includes("requestedRecordingSpeed"));
    // ワーカーが書く`failed`はリトライの対象なので、`failed`では弾かない。
    expect(fallback?.args[0].input.ConditionExpression).toContain("#s <> :done");
    expect(fallback?.args[0].input.ExpressionAttributeValues).not.toHaveProperty(":failed");
    expect(statusValues()).toEqual([expect.objectContaining({ ":s": "launching" })]);
  });

  it("等倍へのフォールバックが条件付き更新で弾かれたらジョブを失敗させずHandleFailureへ委ねる", async () => {
    mockSpeedupJobStore({ ...job, options: { ...job.options, recordingSpeed: 2 } });
    ec2Mock.on(CreateFleetCommand).callsFake(capacityFailure);
    ddbMock
      .on(UpdateCommand, { ExpressionAttributeValues: { ":reason": "gpu_capacity" } }, false)
      .rejects(new ConditionalCheckFailedException({ message: "conditional", $metadata: {} }));

    const { handler } = await import("./launch.js");
    await expect(handler({ jobId: "job-1", attempt: 1, taskToken: "token-xyz" })).rejects.toThrow();

    expect(statusValues()).toEqual([]);
    // WaitBeforeCheckの3分間リースを塞がない。
    expect(ddbMock.commandCalls(TransactWriteCommand).length).toBeGreaterThan(0);
  });

  it("容量不足の記録に失敗しても次の段へ進む", async () => {
    mockSpeedupJobStore({ ...job, options: { ...job.options, recordingSpeed: 2 } });
    ec2Mock
      .on(CreateFleetCommand)
      .callsFakeOnce(capacityFailure)
      .resolves({
        Instances: [{ InstanceIds: ["i-cpu"], InstanceType: "c7i.xlarge", AvailabilityZone: "a" }],
      });
    ddbMock
      .on(UpdateCommand, { UpdateExpression: "SET capacityExhaustedTargets = :targets, updatedAt = :u" }, false)
      .rejects(new Error("throttled"));

    const { handler } = await import("./launch.js");
    await handler({ jobId: "job-1", attempt: 1, taskToken: "token-xyz" });

    expect(ec2Mock.commandCalls(CreateFleetCommand)).toHaveLength(2);
  });
});
