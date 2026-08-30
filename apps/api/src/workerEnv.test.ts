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
  options: { watermark: true, slowMotion: true, th10BugfixMarisaB: false },
  estimatedDurationSeconds: 1757,
} as unknown as JobRecord;

describe("buildWorkerEnv", () => {
  it("低速録画のときだけ FPS_LIMIT_TARGET_HZ を付ける", () => {
    const env = buildWorkerEnv(config, job, "task-token", { slowMotion: true, spotInterruptionWatch: false });

    expect(env.FPS_LIMIT_TARGET_HZ).toBe(String(SLOW_MOTION_TARGET_HZ));
  });

  it("spotInterruptionWatch が有効なら SPOT_INTERRUPTION_WATCH を付ける(EC2起動時)", () => {
    const env = buildWorkerEnv(config, job, "task-token", {
      slowMotion: false,
      spotInterruptionWatch: true,
    });

    expect(env.SPOT_INTERRUPTION_WATCH).toBe("1");
  });

  it("spotInterruptionWatch が無効なら SPOT_INTERRUPTION_WATCH を付けない(自宅ワーカー起動時、Issue #96)", () => {
    const env = buildWorkerEnv(config, job, "task-token", {
      slowMotion: false,
      spotInterruptionWatch: false,
    });

    expect(env.SPOT_INTERRUPTION_WATCH).toBeUndefined();
  });

  it("th10BugfixMarisaB が有効なら EC2/自宅どちらでも TH10_BUGFIX_MARISA_B を付ける", () => {
    const jobWithBugfix = {
      ...job,
      options: { ...job.options, th10BugfixMarisaB: true },
    } as unknown as JobRecord;

    const env = buildWorkerEnv(config, jobWithBugfix, "task-token", { slowMotion: false, spotInterruptionWatch: false });

    expect(env.TH10_BUGFIX_MARISA_B).toBe("1");
  });

  it("th10BugfixMarisaB が無効なら TH10_BUGFIX_MARISA_B を付けない", () => {
    const env = buildWorkerEnv(config, job, "task-token", { slowMotion: false, spotInterruptionWatch: false });

    expect(env.TH10_BUGFIX_MARISA_B).toBeUndefined();
  });

  it("等倍録画では FPS_LIMIT_TARGET_HZ を付けない(未指定＝等倍がワーカー側の既定)", () => {
    const env = buildWorkerEnv(config, job, "task-token", { slowMotion: false, spotInterruptionWatch: false });

    expect(env.FPS_LIMIT_TARGET_HZ).toBeUndefined();
  });

  it("ジョブの options.slowMotion ではなく呼び出し側の指定に従う", () => {
    // EC2 Fleet 起動時(`ec2.buildUserData`)は、ユーザーが低速録画を選んでいても
    // 必ず等倍で起動する。録画に倍の実時間＝倍のSpot料金がかかるため(Issue #68)。
    expect(job.options.slowMotion).toBe(true);

    const env = buildWorkerEnv(config, job, "task-token", { slowMotion: false, spotInterruptionWatch: false });

    expect(env.FPS_LIMIT_TARGET_HZ).toBeUndefined();
    expect(env.GAME).toBe("th20");
  });

  it("redactWorkerEnv は TASK_TOKEN だけを落とし、録画速度の指定は残す", () => {
    const env = buildWorkerEnv(config, job, "task-token", { slowMotion: true, spotInterruptionWatch: false });

    const redacted = redactWorkerEnv(env);

    expect(redacted.TASK_TOKEN).toBeUndefined();
    expect(redacted.FPS_LIMIT_TARGET_HZ).toBe(String(SLOW_MOTION_TARGET_HZ));
  });

  it("replayInfo.score があればリプレイずれ検証用に EXPECTED_SCORE を付ける(Issue #103)", () => {
    const jobWithScore = {
      ...job,
      replayInfo: { score: 481237400 },
    } as unknown as JobRecord;

    const env = buildWorkerEnv(config, jobWithScore, "task-token", { slowMotion: false, spotInterruptionWatch: false });

    expect(env.EXPECTED_SCORE).toBe("481237400");
  });

  it("replayInfo が無い/score が未取得なら EXPECTED_SCORE を付けない", () => {
    const envWithoutReplayInfo = buildWorkerEnv(config, job, "task-token", { slowMotion: false, spotInterruptionWatch: false });
    expect(envWithoutReplayInfo.EXPECTED_SCORE).toBeUndefined();

    const jobWithNullScore = {
      ...job,
      replayInfo: { score: null },
    } as unknown as JobRecord;
    const envWithNullScore = buildWorkerEnv(config, jobWithNullScore, "task-token", {
      slowMotion: false,
      spotInterruptionWatch: false,
    });
    expect(envWithNullScore.EXPECTED_SCORE).toBeUndefined();
  });
});
