import { describe, expect, it } from "vitest";
import type { JobRecord } from "@sattori/shared";
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
  options: { watermark: true, th10BugfixMarisaB: false, th06ncHighResolution: false },
  estimatedDurationSeconds: 1757,
} as unknown as JobRecord;

describe("buildWorkerEnv", () => {
  it("倍速録画では FPS_LIMIT_TARGET_HZ=60×倍率 と GPU_WORKER=1 を付ける(Issue #288)", () => {
    const speedupJob = {
      ...job,
      game: "th07",
      options: { ...job.options, recordingSpeed: 3 },
    } as unknown as JobRecord;
    const env = buildWorkerEnv(config, speedupJob, "task-token", {
      spotInterruptionWatch: true,
    });

    expect(env.FPS_LIMIT_TARGET_HZ).toBe("180");
    expect(env.GPU_WORKER).toBe("1");
    // 倍率はワーカーがFPS_LIMIT_TARGET_HZから導出する(値の食い違いを作らない)。
    expect(env.SPEED_HACK_MULTIPLIER).toBeUndefined();
  });

  it("GPU必須タイトルの等倍録画は GPU_WORKER=1 だけを付ける", () => {
    const th15 = { ...job, game: "th15", options: { ...job.options } } as unknown as JobRecord;
    const env = buildWorkerEnv(config, th15, "task-token", { spotInterruptionWatch: true });

    expect(env.GPU_WORKER).toBe("1");
    expect(env.FPS_LIMIT_TARGET_HZ).toBeUndefined();
  });

  it("CPU系タイトルの等倍録画には GPU_WORKER を付けない", () => {
    const th07 = { ...job, game: "th07", options: { ...job.options } } as unknown as JobRecord;
    const env = buildWorkerEnv(config, th07, "task-token", { spotInterruptionWatch: false });

    expect(env.GPU_WORKER).toBeUndefined();
    expect(env.FPS_LIMIT_TARGET_HZ).toBeUndefined();
  });

  it("spotInterruptionWatch が有効なら SPOT_INTERRUPTION_WATCH を付ける(EC2起動時)", () => {
    const env = buildWorkerEnv(config, job, "task-token", {
      spotInterruptionWatch: true,
    });

    expect(env.SPOT_INTERRUPTION_WATCH).toBe("1");
  });

  it("spotInterruptionWatch が無効なら SPOT_INTERRUPTION_WATCH を付けない(自宅ワーカー起動時、Issue #96)", () => {
    const env = buildWorkerEnv(config, job, "task-token", {
      spotInterruptionWatch: false,
    });

    expect(env.SPOT_INTERRUPTION_WATCH).toBeUndefined();
  });

  it("th10BugfixMarisaB が有効なら EC2/自宅どちらでも TH10_BUGFIX_MARISA_B を付ける", () => {
    const jobWithBugfix = {
      ...job,
      options: { ...job.options, th10BugfixMarisaB: true },
    } as unknown as JobRecord;

    const env = buildWorkerEnv(config, jobWithBugfix, "task-token", { spotInterruptionWatch: false });

    expect(env.TH10_BUGFIX_MARISA_B).toBe("1");
  });

  it("th10BugfixMarisaB が無効なら TH10_BUGFIX_MARISA_B を付けない", () => {
    const env = buildWorkerEnv(config, job, "task-token", { spotInterruptionWatch: false });

    expect(env.TH10_BUGFIX_MARISA_B).toBeUndefined();
  });

  it("等倍録画では FPS_LIMIT_TARGET_HZ を付けない(未指定＝等倍がワーカー側の既定)", () => {
    const env = buildWorkerEnv(config, job, "task-token", { spotInterruptionWatch: false });

    expect(env.FPS_LIMIT_TARGET_HZ).toBeUndefined();
  });

  it("redactWorkerEnv は TASK_TOKEN だけを落とし、録画速度の指定は残す", () => {
    const speedup = { ...job, options: { ...job.options, recordingSpeed: 2 } } as unknown as JobRecord;
    const env = buildWorkerEnv(config, speedup, "task-token", { spotInterruptionWatch: false });

    const redacted = redactWorkerEnv(env);

    expect(redacted.TASK_TOKEN).toBeUndefined();
    expect(redacted.FPS_LIMIT_TARGET_HZ).toBe("120");
  });

  it("replayInfo.score があればリプレイずれ検証用に EXPECTED_SCORE を付ける(Issue #103)", () => {
    const jobWithScore = {
      ...job,
      replayInfo: { score: 481237400 },
    } as unknown as JobRecord;

    const env = buildWorkerEnv(config, jobWithScore, "task-token", { spotInterruptionWatch: false });

    expect(env.EXPECTED_SCORE).toBe("481237400");
  });

  it("th06ncHighResolution が有効なら TH06NC_RESOLUTION=1080p を付ける（Issue #241）", () => {
    const jobWithHighRes = {
      ...job,
      game: "th06nc",
      options: { ...job.options, th06ncHighResolution: true },
    } as unknown as JobRecord;

    const env = buildWorkerEnv(config, jobWithHighRes, "task-token", {
      spotInterruptionWatch: false,
    });

    expect(env.TH06NC_RESOLUTION).toBe("1080p");
  });

  it("th06ncHighResolution が無効なら TH06NC_RESOLUTION を付けない(未指定＝720p)", () => {
    const jobWithoutHighRes = {
      ...job,
      game: "th06nc",
      options: { ...job.options, th06ncHighResolution: false },
    } as unknown as JobRecord;

    const env = buildWorkerEnv(config, jobWithoutHighRes, "task-token", {
      spotInterruptionWatch: false,
    });

    expect(env.TH06NC_RESOLUTION).toBeUndefined();
  });

  it("th06nc以外のタイトルでth06ncHighResolutionがtrueでもTH06NC_RESOLUTIONを付けない", () => {
    const jobWithMismatchedOption = {
      ...job,
      game: "th20",
      options: { ...job.options, th06ncHighResolution: true },
    } as unknown as JobRecord;

    const env = buildWorkerEnv(config, jobWithMismatchedOption, "task-token", {
      spotInterruptionWatch: false,
    });

    expect(env.TH06NC_RESOLUTION).toBeUndefined();
  });

  it("replayInfo が無い/score が未取得なら EXPECTED_SCORE を付けない", () => {
    const envWithoutReplayInfo = buildWorkerEnv(config, job, "task-token", { spotInterruptionWatch: false });
    expect(envWithoutReplayInfo.EXPECTED_SCORE).toBeUndefined();

    const jobWithNullScore = {
      ...job,
      replayInfo: { score: null },
    } as unknown as JobRecord;
    const envWithNullScore = buildWorkerEnv(config, jobWithNullScore, "task-token", {
      spotInterruptionWatch: false,
    });
    expect(envWithNullScore.EXPECTED_SCORE).toBeUndefined();
  });
});
