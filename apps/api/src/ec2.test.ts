import { describe, expect, it } from "vitest";
import type { JobRecord } from "@sattori/shared";
import { buildUserData } from "./ec2.js";
import type { ApiConfig } from "./config.js";

const config: ApiConfig = {
  uploadBucket: "up-bucket",
  outputBucket: "out-bucket",
  cdnDomain: "cdn.example.net",
  jobsTable: "sattori-jobs",
  workerImage: "123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/sattori-worker:latest",
  logGroup: "/sattori/worker",
  maxReplayBytes: 5 * 1024 * 1024,
  ec2: {
    amiId: "ami-xxxx",
    subnetId: "subnet-xxxx",
    instanceProfileArn: "arn:aws:iam::123456789012:instance-profile/sattori-worker",
    securityGroupId: "sg-xxxx",
    instanceType: "c7i.xlarge",
    region: "ap-northeast-1",
  },
};

const job: JobRecord = {
  jobId: "job-1",
  game: "th07",
  replayKey: "replays/abc.rpy",
  status: "queued",
  options: { watermark: true },
  outputPath: null,
  error: null,
  createdAt: "2026-07-17T00:00:00.000Z",
  updatedAt: "2026-07-17T00:00:00.000Z",
  email: null,
};

describe("buildUserData", () => {
  it("ジョブのパラメータを環境変数として埋め込む", () => {
    const decoded = Buffer.from(buildUserData(config, job), "base64").toString("utf-8");
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
  });

  it("ウォーターマーク無効時は WATERMARK=0", () => {
    const decoded = Buffer.from(
      buildUserData(config, { ...job, options: { watermark: false } }),
      "base64",
    ).toString("utf-8");
    expect(decoded).toContain("WATERMARK=0");
  });
});
