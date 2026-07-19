import { beforeEach, describe, expect, it } from "vitest";
import {
  CreateFleetCommand,
  CreateLaunchTemplateVersionCommand,
  EC2Client,
  TerminateInstancesCommand,
} from "@aws-sdk/client-ec2";
import { mockClient } from "aws-sdk-client-mock";
import type { JobRecord } from "@sattori/shared";
import { buildUserData, launchRecordingInstance, terminateInstance } from "./ec2.js";
import type { ApiConfig } from "./config.js";

const ec2Mock = mockClient(EC2Client);

const config: ApiConfig = {
  uploadBucket: "up-bucket",
  outputBucket: "out-bucket",
  cdnDomain: "cdn.example.net",
  jobsTable: "sattori-jobs",
  workerImage: "123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/sattori-worker:latest",
  logGroup: "/sattori/worker",
  maxReplayBytes: 5 * 1024 * 1024,
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
  options: { watermark: true },
  outputPath: null,
  outputPath720p: null,
  error: null,
  createdAt: "2026-07-17T00:00:00.000Z",
  updatedAt: "2026-07-17T00:00:00.000Z",
  email: null,
  instanceId: null,
  estimatedDurationSeconds: 900,
  progress: null,
  previewImagePath: null,
};

describe("buildUserData", () => {
  it("ジョブのパラメータを環境変数として埋め込む", () => {
    const decoded = Buffer.from(buildUserData(config, job, "task-token-abc"), "base64").toString(
      "utf-8",
    );
    expect(decoded).toContain("JOB_ID=job-1");
    expect(decoded).toContain("REPLAY_KEY=replays/abc.rpy");
    expect(decoded).toContain("OUTPUT_BUCKET=out-bucket");
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
    expect(decoded).toContain("EXPECTED_DURATION_SECONDS=900");
  });

  it("ウォーターマーク無効時は WATERMARK=0", () => {
    const decoded = Buffer.from(
      buildUserData(config, { ...job, options: { watermark: false } }, "task-token-abc"),
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

  it("Launch Template の新バージョンを作成し、EC2 Fleet で起動してinstanceIdを返す", async () => {
    ec2Mock.on(CreateLaunchTemplateVersionCommand).resolves({
      LaunchTemplateVersion: { VersionNumber: 3 },
    });
    ec2Mock.on(CreateFleetCommand).resolves({
      Instances: [{ InstanceIds: ["i-0123456789abcdef0"] }],
    });

    const instanceId = await launchRecordingInstance(config, job, "task-token-abc");

    expect(instanceId).toBe("i-0123456789abcdef0");

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
      SpotOptions: { AllocationStrategy: "lowest-price" },
    });
    expect(fleetCall?.args[0].input.LaunchTemplateConfigs?.[0]).toMatchObject({
      LaunchTemplateSpecification: { LaunchTemplateId: "lt-xxxx", Version: "3" },
      Overrides: [{ SubnetId: "subnet-aaaa" }, { SubnetId: "subnet-bbbb" }],
    });
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
