import { beforeEach, describe, expect, it } from "vitest";
import {
  CreateFleetCommand,
  CreateLaunchTemplateVersionCommand,
  DescribeInstancesCommand,
  DescribeSpotPriceHistoryCommand,
  EC2Client,
  TerminateInstancesCommand,
} from "@aws-sdk/client-ec2";
import { mockClient } from "aws-sdk-client-mock";
import type { JobRecord } from "@sattori/shared";
import {
  buildUserData,
  fetchSpotPrice,
  findJobInstanceIds,
  launchRecordingInstance,
  listTaggedInstances,
  terminateInstance,
} from "./ec2.js";
import type { ApiConfig } from "./config.js";

const ec2Mock = mockClient(EC2Client);

const config: ApiConfig = {
  uploadBucket: "up-bucket",
  outputBucket: "out-bucket",
  cdnDomain: "cdn.example.net",
  jobsTable: "sattori-jobs",
  workerImage: "123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/sattori-worker:latest",
  titleAssetsBucket: "title-assets-bucket",
  logGroup: "/sattori/worker",
  maxReplayBytes: 5 * 1024 * 1024,
  emailRateLimitTable: "email-rate-limit",
  settingsTable: "sattori-settings",
  workersTable: "sattori-workers",
  sesFromAddress: "no-reply@sattori.hakatashi.com",
  webBaseUrl: "https://sattori.hakatashi.com",
  ec2: {
    subnetIds: ["subnet-aaaa", "subnet-bbbb"],
    region: "ap-northeast-1",
    launchTemplateId: "lt-xxxx",
  },
};

const job: JobRecord = {
  jobId: "job-1",
  game: "th07",
  replayKey: "replays/abc.rpy",
  status: "queued",
  options: { watermark: true, slowMotion: false },
  outputPath: null,
  outputPath720p: null,
  error: null,
  createdAt: "2026-07-17T00:00:00.000Z",
  updatedAt: "2026-07-17T00:00:00.000Z",
  doneAt: null,
  email: null,
  instanceId: null,
  workerKind: null,
  instanceType: null,
  availabilityZone: null,
  spotPricePerHour: null,
  launchedAt: null,
  outputBytes: null,
  outputBytes720p: null,
  estimatedDurationSeconds: 900,
  progress: null,
  previewImagePath: null,
  replayInfo: null,
  pendingExpiresAt: null,
  retriedToJobId: null,
  retriedFromJobId: null,
  language: "ja",
};

describe("buildUserData", () => {
  it("ジョブのパラメータを環境変数として埋め込む", () => {
    const decoded = Buffer.from(buildUserData(config, job, "task-token-abc"), "base64").toString(
      "utf-8",
    );
    expect(decoded).toContain("JOB_ID=job-1");
    expect(decoded).toContain("REPLAY_KEY=replays/abc.rpy");
    expect(decoded).toContain("OUTPUT_BUCKET=out-bucket");
    expect(decoded).toContain("TITLE_ASSETS_BUCKET=title-assets-bucket");
    expect(decoded).toContain("WATERMARK=1");
    expect(decoded).toContain(config.workerImage);
    // ECR ログイン先レジストリが正しく抽出されている
    expect(decoded).toContain("123456789012.dkr.ecr.ap-northeast-1.amazonaws.com");
    expect(decoded).toContain("shutdown -h now");
    // ECS エージェントを停止して x11grab とのCPUコンテンションを避ける
    expect(decoded).toContain("systemctl disable --now ecs");
    // CloudWatch Logs へジョブIDのストリームで送出する
    expect(decoded).toContain("--log-driver awslogs");
    expect(decoded).toContain("awslogs-group=/sattori/worker");
    expect(decoded).toContain("awslogs-stream=job-1");
    // taskToken と進捗算出用の推定再生時間を渡す
    expect(decoded).toContain("TASK_TOKEN='task-token-abc'");
    expect(decoded).toContain('-e TASK_TOKEN="$TASK_TOKEN"');
    expect(decoded).toContain("EXPECTED_DURATION_SECONDS=900");
    // コンテナ起動前(ECR ログイン/pull)の失敗は bash から直接 SendTaskFailure する
    expect(decoded).toContain("send-task-failure");
    expect(decoded).toContain("docker pull");
  });

  it("ウォーターマーク無効時は WATERMARK=0", () => {
    const decoded = Buffer.from(
      buildUserData(config, { ...job, options: { watermark: false, slowMotion: false } }, "task-token-abc"),
      "base64",
    ).toString("utf-8");
    expect(decoded).toContain("WATERMARK=0");
  });

  it("estimatedDurationSeconds が null なら EXPECTED_DURATION_SECONDS を付与しない", () => {
    const decoded = Buffer.from(
      buildUserData(config, { ...job, estimatedDurationSeconds: null }, "task-token-abc"),
      "base64",
    ).toString("utf-8");
    expect(decoded).not.toContain("EXPECTED_DURATION_SECONDS");
  });
});

describe("launchRecordingInstance", () => {
  beforeEach(() => {
    ec2Mock.reset();
  });

  it("Launch Template の新バージョンを作成し、EC2 Fleet で起動して実際に確保されたインスタンス情報を返す", async () => {
    ec2Mock.on(CreateLaunchTemplateVersionCommand).resolves({
      LaunchTemplateVersion: { VersionNumber: 3 },
    });
    ec2Mock.on(CreateFleetCommand).resolves({
      Instances: [
        {
          InstanceIds: ["i-0123456789abcdef0"],
          InstanceType: "c7i.xlarge",
          AvailabilityZone: "ap-northeast-1a",
        },
      ],
    });

    ec2Mock.on(DescribeSpotPriceHistoryCommand).resolves({
      SpotPriceHistory: [{ SpotPrice: "0.0612" }],
    });

    const instance = await launchRecordingInstance(config, job, "task-token-abc");

    expect(instance).toEqual({
      instanceId: "i-0123456789abcdef0",
      instanceType: "c7i.xlarge",
      availabilityZone: "ap-northeast-1a",
      spotPricePerHour: 0.0612,
    });

    const versionCall = ec2Mock.commandCalls(CreateLaunchTemplateVersionCommand)[0];
    expect(versionCall?.args[0].input).toMatchObject({
      LaunchTemplateId: "lt-xxxx",
      SourceVersion: "$Default",
    });

    const fleetCall = ec2Mock.commandCalls(CreateFleetCommand)[0];
    expect(fleetCall?.args[0].input).toMatchObject({
      Type: "instant",
      TargetCapacitySpecification: {
        TotalTargetCapacity: 1,
        DefaultTargetCapacityType: "spot",
      },
      SpotOptions: {
        AllocationStrategy: "price-capacity-optimized",
        SingleInstanceType: false,
      },
    });
    // サブネット(AZ) × 候補インスタンスタイプの全組み合わせをOverridesに渡す
    // （単一AZ・単一インスタンスタイプでのSpot枯渇耐性、Issue #29）
    const overrides = fleetCall?.args[0].input.LaunchTemplateConfigs?.[0]?.Overrides ?? [];
    expect(overrides.length).toBeGreaterThan(2);
    expect(overrides).toEqual(
      expect.arrayContaining([
        { SubnetId: "subnet-aaaa", InstanceType: "c7i.xlarge" },
        { SubnetId: "subnet-bbbb", InstanceType: "c7i.xlarge" },
        { SubnetId: "subnet-aaaa", InstanceType: "c7a.xlarge" },
        { SubnetId: "subnet-bbbb", InstanceType: "c7i-flex.xlarge" },
        { SubnetId: "subnet-aaaa", InstanceType: "m7i.xlarge" },
      ]),
    );
    expect(fleetCall?.args[0].input.LaunchTemplateConfigs?.[0]).toMatchObject({
      LaunchTemplateSpecification: { LaunchTemplateId: "lt-xxxx", Version: "3" },
    });
  });

  it("th11ジョブは.2xlarge帯の専用インスタンスタイプで起動する", async () => {
    ec2Mock.on(CreateLaunchTemplateVersionCommand).resolves({
      LaunchTemplateVersion: { VersionNumber: 3 },
    });
    ec2Mock.on(CreateFleetCommand).resolves({
      Instances: [{ InstanceIds: ["i-0123456789abcdef0"] }],
    });

    const instance = await launchRecordingInstance(config, { ...job, game: "th11" }, "task-token-abc");
    // InstanceType/AvailabilityZoneがレスポンスに含まれない場合はnullにフォールバックする
    expect(instance.instanceType).toBeNull();
    expect(instance.availabilityZone).toBeNull();

    const fleetCall = ec2Mock.commandCalls(CreateFleetCommand)[0];
    const overrides = fleetCall?.args[0].input.LaunchTemplateConfigs?.[0]?.Overrides ?? [];
    // th11は8vCPU/16GiB以上(.2xlarge帯)が必要（本番の処理落ち実測、touhou-recorder reports/40）
    expect(overrides).toEqual(
      expect.arrayContaining([
        { SubnetId: "subnet-aaaa", InstanceType: "c7i.2xlarge" },
        { SubnetId: "subnet-bbbb", InstanceType: "c7i.2xlarge" },
        { SubnetId: "subnet-aaaa", InstanceType: "c7a.2xlarge" },
        { SubnetId: "subnet-bbbb", InstanceType: "c7a.2xlarge" },
        { SubnetId: "subnet-aaaa", InstanceType: "m7i.2xlarge" },
      ]),
    );
    // th06/07/08向けの.xlarge帯は含まれない
    for (const override of overrides) {
      expect(override.InstanceType).not.toMatch(/\.xlarge$/);
    }
  });

  it("インスタンスが起動できなかった場合は Errors を含めて例外を投げる", async () => {
    ec2Mock.on(CreateLaunchTemplateVersionCommand).resolves({
      LaunchTemplateVersion: { VersionNumber: 1 },
    });
    ec2Mock.on(CreateFleetCommand).resolves({
      Instances: [],
      Errors: [{ ErrorCode: "InsufficientCapacity", ErrorMessage: "no capacity" }],
    });

    await expect(launchRecordingInstance(config, job, "task-token-abc")).rejects.toThrow(
      /InsufficientCapacity/,
    );
  });
});

describe("terminateInstance", () => {
  beforeEach(() => {
    ec2Mock.reset();
  });

  it("TerminateInstances を呼ぶ", async () => {
    ec2Mock.on(TerminateInstancesCommand).resolves({});
    await terminateInstance("i-0123456789abcdef0");
    expect(ec2Mock.commandCalls(TerminateInstancesCommand)[0]?.args[0].input).toEqual({
      InstanceIds: ["i-0123456789abcdef0"],
    });
  });

  it("既に存在しないインスタンスは冪等に成功扱いにする", async () => {
    const err = Object.assign(new Error("not found"), { name: "InvalidInstanceID.NotFound" });
    ec2Mock.on(TerminateInstancesCommand).rejects(err);
    await expect(terminateInstance("i-0123456789abcdef0")).resolves.toBeUndefined();
  });

  it("それ以外のエラーは再送出する", async () => {
    const err = Object.assign(new Error("boom"), { name: "SomeOtherError" });
    ec2Mock.on(TerminateInstancesCommand).rejects(err);
    await expect(terminateInstance("i-0123456789abcdef0")).rejects.toThrow("boom");
  });
});

describe("findJobInstanceIds", () => {
  beforeEach(() => {
    ec2Mock.reset();
  });

  it("タグ(sattori:jobId)と未終了の状態でフィルタして全インスタンスIDを返す", async () => {
    // Step Functionsのリトライで複数台が孤児化していることもあるため、
    // Reservationを跨いで平坦化して返す。
    ec2Mock.on(DescribeInstancesCommand).resolves({
      Reservations: [
        { Instances: [{ InstanceId: "i-aaa" }, { InstanceId: undefined }] },
        { Instances: [{ InstanceId: "i-bbb" }] },
        {},
      ],
    });

    await expect(findJobInstanceIds("job-1")).resolves.toEqual(["i-aaa", "i-bbb"]);
    expect(ec2Mock.commandCalls(DescribeInstancesCommand)[0]?.args[0].input.Filters).toEqual([
      { Name: "tag:sattori:jobId", Values: ["job-1"] },
      { Name: "instance-state-name", Values: ["pending", "running", "stopping", "stopped"] },
    ]);
  });

  it("該当インスタンスが無ければ空配列", async () => {
    ec2Mock.on(DescribeInstancesCommand).resolves({});
    await expect(findJobInstanceIds("job-1")).resolves.toEqual([]);
  });
});

describe("listTaggedInstances", () => {
  beforeEach(() => {
    ec2Mock.reset();
  });

  it("ジョブIDタグを持つ生存インスタンスを、タグの値と起動時刻つきで返す", async () => {
    const launchTime = new Date("2026-08-14T00:00:00.000Z");
    ec2Mock.on(DescribeInstancesCommand).resolves({
      Reservations: [
        {
          Instances: [
            {
              InstanceId: "i-aaa",
              LaunchTime: launchTime,
              Tags: [
                { Key: "Name", Value: "sattori-recorder" },
                { Key: "sattori:jobId", Value: "job-1" },
              ],
            },
            // タグが無い/空のインスタンスはジョブに紐づけられないので捨てる
            // （このサービス以外が同じフィルタに引っかかることは無いはずだが、
            // 判定できないものをterminate候補にしないため）。
            { InstanceId: "i-notag", Tags: [{ Key: "Name", Value: "other" }] },
          ],
        },
        {
          Instances: [
            { InstanceId: "i-bbb", Tags: [{ Key: "sattori:jobId", Value: "job-2" }] },
          ],
        },
      ],
    });

    await expect(listTaggedInstances()).resolves.toEqual([
      { instanceId: "i-aaa", jobId: "job-1", launchTime },
      // LaunchTimeが返らなかった場合はnull（判定側が「たった今起動した」扱いにする）。
      { instanceId: "i-bbb", jobId: "job-2", launchTime: null },
    ]);
    expect(ec2Mock.commandCalls(DescribeInstancesCommand)[0]?.args[0].input.Filters).toEqual([
      { Name: "tag-key", Values: ["sattori:jobId"] },
      { Name: "instance-state-name", Values: ["pending", "running", "stopping", "stopped"] },
    ]);
  });

  it("NextTokenが返る限りページングして全件集める", async () => {
    ec2Mock
      .on(DescribeInstancesCommand)
      .resolvesOnce({
        Reservations: [
          { Instances: [{ InstanceId: "i-aaa", Tags: [{ Key: "sattori:jobId", Value: "job-1" }] }] },
        ],
        NextToken: "token-1",
      })
      .resolvesOnce({
        Reservations: [
          { Instances: [{ InstanceId: "i-bbb", Tags: [{ Key: "sattori:jobId", Value: "job-2" }] }] },
        ],
      });

    const instances = await listTaggedInstances();
    expect(instances.map((instance) => instance.instanceId)).toEqual(["i-aaa", "i-bbb"]);
    expect(ec2Mock.commandCalls(DescribeInstancesCommand)[1]?.args[0].input.NextToken).toBe(
      "token-1",
    );
  });
});

describe("fetchSpotPrice", () => {
  beforeEach(() => {
    ec2Mock.reset();
  });

  it("直近1件のSpot価格履歴を数値で返す", async () => {
    ec2Mock.on(DescribeSpotPriceHistoryCommand).resolves({
      SpotPriceHistory: [{ SpotPrice: "0.058300" }],
    });

    await expect(fetchSpotPrice("c7i.xlarge", "us-east-1a")).resolves.toBe(0.0583);
    expect(ec2Mock.commandCalls(DescribeSpotPriceHistoryCommand)[0]?.args[0].input).toMatchObject({
      InstanceTypes: ["c7i.xlarge"],
      AvailabilityZone: "us-east-1a",
      ProductDescriptions: ["Linux/UNIX"],
      MaxResults: 1,
    });
  });

  it("インスタンスタイプ・AZが不明ならAPIを呼ばずにnull", async () => {
    await expect(fetchSpotPrice(null, "us-east-1a")).resolves.toBeNull();
    await expect(fetchSpotPrice("c7i.xlarge", null)).resolves.toBeNull();
    expect(ec2Mock.commandCalls(DescribeSpotPriceHistoryCommand)).toHaveLength(0);
  });

  it("履歴が空・数値でない場合はnull", async () => {
    ec2Mock.on(DescribeSpotPriceHistoryCommand).resolves({ SpotPriceHistory: [] });
    await expect(fetchSpotPrice("c7i.xlarge", "us-east-1a")).resolves.toBeNull();

    ec2Mock.on(DescribeSpotPriceHistoryCommand).resolves({
      SpotPriceHistory: [{ SpotPrice: "N/A" }],
    });
    await expect(fetchSpotPrice("c7i.xlarge", "us-east-1a")).resolves.toBeNull();
  });

  it("APIが失敗しても例外を投げずnullを返す（録画そのものを落とさないため）", async () => {
    ec2Mock.on(DescribeSpotPriceHistoryCommand).rejects(new Error("throttled"));
    await expect(fetchSpotPrice("c7i.xlarge", "us-east-1a")).resolves.toBeNull();
  });
});
