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
  it("GPUの段の倍速録画では FPS_LIMIT_TARGET_HZ=60×倍率 と GPU_WORKER=1 を付ける(Issue #288)", () => {
    const speedupJob = {
      ...job,
      game: "th07",
      options: { ...job.options, recordingSpeed: 3 },
    } as unknown as JobRecord;
    const env = buildWorkerEnv(config, speedupJob, "task-token", {
      spotInterruptionWatch: true, dataRegion: config.ec2.region, gpuWorker: true });

    expect(env.FPS_LIMIT_TARGET_HZ).toBe("180");
    expect(env.GPU_WORKER).toBe("1");
    // 倍率はワーカーがFPS_LIMIT_TARGET_HZから導出する(値の食い違いを作らない)。
    expect(env.SPEED_HACK_MULTIPLIER).toBeUndefined();
  });

  it.each([
    [1 / 2, "30"],
    [1 / 3, "20"],
  ])("低速録画(%s倍速)は FPS_LIMIT_TARGET_HZ だけを付け GPU_WORKER を付けない(Issue #316)", (speed, hz) => {
    const slowJob = {
      ...job,
      game: "th15",
      options: { ...job.options, recordingSpeed: speed },
    } as unknown as JobRecord;
    const env = buildWorkerEnv(config, slowJob, "task-token", {
      spotInterruptionWatch: true, dataRegion: config.ec2.region, gpuWorker: false });

    expect(env.FPS_LIMIT_TARGET_HZ).toBe(hz);
    expect(env.GPU_WORKER).toBeUndefined();
  });

  it("GPUの段の等倍録画は GPU_WORKER=1 だけを付ける", () => {
    const th15 = { ...job, game: "th15", options: { ...job.options } } as unknown as JobRecord;
    const env = buildWorkerEnv(config, th15, "task-token", { spotInterruptionWatch: true, dataRegion: config.ec2.region, gpuWorker: true });

    expect(env.GPU_WORKER).toBe("1");
    expect(env.FPS_LIMIT_TARGET_HZ).toBeUndefined();
  });

  it("CPUの段（自宅ワーカーを含む）には GPU_WORKER を付けない", () => {
    const th07 = { ...job, game: "th07", options: { ...job.options } } as unknown as JobRecord;
    const env = buildWorkerEnv(config, th07, "task-token", { spotInterruptionWatch: false, dataRegion: config.ec2.region, gpuWorker: false });

    expect(env.GPU_WORKER).toBeUndefined();
    expect(env.FPS_LIMIT_TARGET_HZ).toBeUndefined();
  });

  it("spotInterruptionWatch が有効なら SPOT_INTERRUPTION_WATCH を付ける(EC2起動時)", () => {
    const env = buildWorkerEnv(config, job, "task-token", {
      spotInterruptionWatch: true, dataRegion: config.ec2.region, gpuWorker: false });

    expect(env.SPOT_INTERRUPTION_WATCH).toBe("1");
  });

  it("spotInterruptionWatch が無効なら SPOT_INTERRUPTION_WATCH を付けない(自宅ワーカー起動時、Issue #96)", () => {
    const env = buildWorkerEnv(config, job, "task-token", {
      spotInterruptionWatch: false, dataRegion: config.ec2.region, gpuWorker: false });

    expect(env.SPOT_INTERRUPTION_WATCH).toBeUndefined();
  });

  it("th10BugfixMarisaB が有効なら EC2/自宅どちらでも TH10_BUGFIX_MARISA_B を付ける", () => {
    const jobWithBugfix = {
      ...job,
      options: { ...job.options, th10BugfixMarisaB: true },
    } as unknown as JobRecord;

    const env = buildWorkerEnv(config, jobWithBugfix, "task-token", { spotInterruptionWatch: false, dataRegion: config.ec2.region, gpuWorker: false });

    expect(env.TH10_BUGFIX_MARISA_B).toBe("1");
  });

  it("th10BugfixMarisaB が無効なら TH10_BUGFIX_MARISA_B を付けない", () => {
    const env = buildWorkerEnv(config, job, "task-token", { spotInterruptionWatch: false, dataRegion: config.ec2.region, gpuWorker: false });

    expect(env.TH10_BUGFIX_MARISA_B).toBeUndefined();
  });

  it("等倍録画では FPS_LIMIT_TARGET_HZ を付けない(未指定＝等倍がワーカー側の既定)", () => {
    const env = buildWorkerEnv(config, job, "task-token", { spotInterruptionWatch: false, dataRegion: config.ec2.region, gpuWorker: false });

    expect(env.FPS_LIMIT_TARGET_HZ).toBeUndefined();
  });

  it("redactWorkerEnv は TASK_TOKEN だけを落とし、録画速度の指定は残す", () => {
    const speedup = { ...job, options: { ...job.options, recordingSpeed: 2 } } as unknown as JobRecord;
    const env = buildWorkerEnv(config, speedup, "task-token", { spotInterruptionWatch: false, dataRegion: config.ec2.region, gpuWorker: false });

    const redacted = redactWorkerEnv(env);

    expect(redacted.TASK_TOKEN).toBeUndefined();
    expect(redacted.FPS_LIMIT_TARGET_HZ).toBe("120");
  });

  it("replayInfo.score があればリプレイずれ検証用に EXPECTED_SCORE を付ける(Issue #103)", () => {
    const jobWithScore = {
      ...job,
      replayInfo: { score: 481237400 },
    } as unknown as JobRecord;

    const env = buildWorkerEnv(config, jobWithScore, "task-token", { spotInterruptionWatch: false, dataRegion: config.ec2.region, gpuWorker: false });

    expect(env.EXPECTED_SCORE).toBe("481237400");
  });

  it("1080pオプションが残った旧レコードでも TH06NC_RESOLUTION を付けない（Issue #317で廃止）", () => {
    const jobWithHighRes = {
      ...job,
      game: "th06nc",
      options: { ...job.options, th06ncHighResolution: true },
    } as unknown as JobRecord;

    const env = buildWorkerEnv(config, jobWithHighRes, "task-token", {
      spotInterruptionWatch: false, dataRegion: config.ec2.region, gpuWorker: true,
    });

    expect(env.TH06NC_RESOLUTION).toBeUndefined();
  });

  it("replayInfo が無い/score が未取得なら EXPECTED_SCORE を付けない", () => {
    const envWithoutReplayInfo = buildWorkerEnv(config, job, "task-token", { spotInterruptionWatch: false, dataRegion: config.ec2.region, gpuWorker: false });
    expect(envWithoutReplayInfo.EXPECTED_SCORE).toBeUndefined();

    const jobWithNullScore = {
      ...job,
      replayInfo: { score: null },
    } as unknown as JobRecord;
    const envWithNullScore = buildWorkerEnv(config, jobWithNullScore, "task-token", {
      spotInterruptionWatch: false, dataRegion: config.ec2.region, gpuWorker: false });
    expect(envWithNullScore.EXPECTED_SCORE).toBeUndefined();
  });
});

describe("buildWorkerEnv のデータバケット（Issue #313）", () => {
  const configWithFallback = {
    ...config,
    ec2: {
      ...config.ec2,
      gpuFallback: {
        region: "eu-north-1",
        launchTemplateName: "sattori-gpu-worker",
        subnetTagKey: "sattori:gpuWorkerSubnet",
        workerGpuImage: "123456789012.dkr.ecr.eu-north-1.amazonaws.com/sattori-worker-gpu:latest",
        outputBucket: "out-eun1",
        titleAssetsBucket: "title-assets-eun1",
      },
    },
  } as unknown as ApiConfig;

  it("一次リージョンで動くなら一次リージョンのバケットを渡す", () => {
    const env = buildWorkerEnv(configWithFallback, job, "task-token", {
      spotInterruptionWatch: true,
      dataRegion: "eu-south-2", gpuWorker: false });
    expect(env.OUTPUT_BUCKET).toBe("out-bucket");
    expect(env.OUTPUT_BUCKET_REGION).toBe("eu-south-2");
    expect(env.TITLE_ASSETS_BUCKET).toBe("title-assets");
    expect(env.TITLE_ASSETS_BUCKET_REGION).toBe("eu-south-2");
    expect(env.CHECKPOINT_BUCKET).toBe("out-bucket");
    expect(env.CHECKPOINT_BUCKET_REGION).toBe("eu-south-2");
  });

  it("フォールバック先で動くなら、出力とタイトル資産はそのリージョンのバケットを渡す", () => {
    const env = buildWorkerEnv(configWithFallback, job, "task-token", {
      spotInterruptionWatch: true,
      dataRegion: "eu-north-1", gpuWorker: false });
    expect(env.OUTPUT_BUCKET).toBe("out-eun1");
    expect(env.OUTPUT_BUCKET_REGION).toBe("eu-north-1");
    expect(env.TITLE_ASSETS_BUCKET).toBe("title-assets-eun1");
    expect(env.TITLE_ASSETS_BUCKET_REGION).toBe("eu-north-1");
    // データ面の他の部分は一次リージョンのまま。
    expect(env.AWS_REGION).toBe("eu-south-2");
    expect(env.REPLAY_BUCKET).toBe("up-bucket");
    // 前回の出力が無いので、チェックポイントは一次リージョンを見る。
    expect(env.CHECKPOINT_BUCKET).toBe("out-bucket");
    expect(env.CHECKPOINT_BUCKET_REGION).toBe("eu-south-2");
  });

  it("前回の試行が別リージョンへ書いたチェックポイントは、そのリージョンから読む", () => {
    const retried = { ...job, outputRegion: "eu-north-1" } as unknown as JobRecord;
    const env = buildWorkerEnv(configWithFallback, retried, "task-token", {
      spotInterruptionWatch: true,
      dataRegion: "eu-south-2", gpuWorker: false });
    expect(env.OUTPUT_BUCKET).toBe("out-bucket");
    expect(env.CHECKPOINT_BUCKET).toBe("out-eun1");
    expect(env.CHECKPOINT_BUCKET_REGION).toBe("eu-north-1");
  });

  it("フォールバック未設定なら、どのリージョンを渡しても一次リージョンのバケットになる", () => {
    const env = buildWorkerEnv(config, job, "task-token", {
      spotInterruptionWatch: true,
      dataRegion: "eu-north-1", gpuWorker: false });
    expect(env.OUTPUT_BUCKET).toBe("out-bucket");
    expect(env.OUTPUT_BUCKET_REGION).toBe("eu-south-2");
  });
});
