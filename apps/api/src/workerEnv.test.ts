import { describe, expect, it } from "vitest";
import { SLOW_MOTION_TARGET_HZ, type JobRecord } from "@sattori/shared";
import type { ApiConfig } from "./config.js";
import { buildWorkerEnv, redactWorkerEnv } from "./workerEnv.js";

const config = {
  uploadBucket: "up-bucket",
  outputBucket: "out-bucket",
  titleAssetsBucket: "title-assets",
  jobsTable: "sattori-jobs",
  workersTable: "sattori-workers",
  logGroup: "/sattori/worker",
  workerImage: "123456789012.dkr.ecr.eu-south-2.amazonaws.com/sattori-worker:latest",
  ec2: {
    region: "eu-south-2",
    subnetIds: ["subnet-a"],
    launchTemplateId: "lt-1",
  },
} as unknown as ApiConfig;

const job = {
  jobId: "job-1",
  game: "th20",
  replayKey: "replays/abc.rpy",
  options: { watermark: true, slowMotion: true },
  estimatedDurationSeconds: 1757,
} as unknown as JobRecord;

describe("buildWorkerEnv", () => {
  it("低速録画のときだけ FPS_LIMIT_TARGET_HZ を付ける", () => {
    const env = buildWorkerEnv(config, job, "task-token", { slowMotion: true });

    expect(env.FPS_LIMIT_TARGET_HZ).toBe(String(SLOW_MOTION_TARGET_HZ));
  });

  it("等倍録画では FPS_LIMIT_TARGET_HZ を付けない(未指定＝等倍がワーカー側の既定)", () => {
    const env = buildWorkerEnv(config, job, "task-token", { slowMotion: false });

    expect(env.FPS_LIMIT_TARGET_HZ).toBeUndefined();
  });

  it("ジョブの options.slowMotion ではなく呼び出し側の指定に従う", () => {
    // EC2 Fleet 起動時(`ec2.buildUserData`)は、ユーザーが低速録画を選んでいても
    // 必ず等倍で起動する。録画に倍の実時間＝倍のSpot料金がかかるため(Issue #68)。
    expect(job.options.slowMotion).toBe(true);

    const env = buildWorkerEnv(config, job, "task-token", { slowMotion: false });

    expect(env.FPS_LIMIT_TARGET_HZ).toBeUndefined();
    expect(env.GAME).toBe("th20");
  });

  it("redactWorkerEnv は TASK_TOKEN だけを落とし、録画速度の指定は残す", () => {
    const env = buildWorkerEnv(config, job, "task-token", { slowMotion: true });

    const redacted = redactWorkerEnv(env);

    expect(redacted.TASK_TOKEN).toBeUndefined();
    expect(redacted.FPS_LIMIT_TARGET_HZ).toBe(String(SLOW_MOTION_TARGET_HZ));
  });
});
