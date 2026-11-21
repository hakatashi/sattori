import { describe, expect, it } from "vitest";
import { remainingRecordingSteps } from "@sattori/shared";
import { buildExperimentJob, parseExperimentRequest, toExperimentResult } from "./experiments.js";
import { createJobRecord } from "./testSupport/jobRecord.js";

const regions = { primary: "eu-south-2", gpuFallback: "eu-north-1" };
const REPLAY_KEY = "replays/11111111-1111-1111-1111-111111111111.rpy";

function ec2Request(overrides: Record<string, unknown> = {}) {
  return {
    replayKey: REPLAY_KEY,
    game: "th15",
    step: {
      kind: "ec2",
      platform: "cpu",
      region: "eu-south-2",
      instanceTypes: ["c7i.4xlarge"],
      captureMode: "realtime",
      speed: 1 / 2,
    },
    ...overrides,
  };
}

describe("parseExperimentRequest", () => {
  it("CPUのEC2の段を1段の計画へ変換する", () => {
    const parsed = parseExperimentRequest(ec2Request({ note: "4xlargeの確認" }), regions);
    expect(parsed).toMatchObject({
      ok: true,
      source: { replayKey: REPLAY_KEY, game: "th15" },
      spec: {
        note: "4xlargeの確認",
        step: {
          id: "experiment:cpu:eu-south-2",
          kind: "ec2",
          platform: "cpu",
          instanceTypes: ["c7i.4xlarge"],
          captureMode: "realtime",
          speed: 1 / 2,
        },
      },
    });
  });

  it("frameSyncはspeed 1に固定する", () => {
    const base = ec2Request();
    const ok = parseExperimentRequest(
      { ...base, step: { ...base.step, captureMode: "frameSync", speed: undefined } },
      regions,
    );
    expect(ok).toMatchObject({ ok: true, spec: { step: { captureMode: "frameSync", speed: 1 } } });
    const bad = parseExperimentRequest(
      { ...base, step: { ...base.step, captureMode: "frameSync", speed: 2 } },
      regions,
    );
    expect(bad.ok).toBe(false);
  });

  it("検証用イメージは一次リージョンのEC2の段でしか使えない", () => {
    expect(parseExperimentRequest(ec2Request({ workerImageTag: "exp-1" }), regions).ok).toBe(true);
    const home = parseExperimentRequest(
      {
        replayKey: REPLAY_KEY,
        game: "th15",
        workerImageTag: "exp-1",
        step: { kind: "home", captureMode: "realtime", speed: 1 },
      },
      regions,
    );
    expect(home).toMatchObject({ ok: false });
    const fallback = parseExperimentRequest(
      ec2Request({
        workerImageTag: "exp-1",
        step: {
          kind: "ec2",
          platform: "gpu",
          region: "eu-north-1",
          instanceTypes: ["g6f.2xlarge"],
          captureMode: "realtime",
          speed: 2,
        },
      }),
      regions,
    );
    expect(fallback).toMatchObject({ ok: false });
  });

  it("シェルに埋め込めないタグ・不正なインスタンスタイプ・未知のGPUタイプを弾く", () => {
    expect(parseExperimentRequest(ec2Request({ workerImageTag: "a;rm -rf /" }), regions).ok).toBe(false);
    const base = ec2Request();
    expect(
      parseExperimentRequest({ ...base, step: { ...base.step, instanceTypes: ["c7i 4xlarge"] } }, regions).ok,
    ).toBe(false);
    expect(
      parseExperimentRequest(
        { ...base, step: { ...base.step, platform: "gpu", instanceTypes: ["g99.huge"] } },
        regions,
      ).ok,
    ).toBe(false);
  });

  it("CPUの段はフォールバック先リージョンを指定できない", () => {
    const base = ec2Request();
    expect(parseExperimentRequest({ ...base, step: { ...base.step, region: "eu-north-1" } }, regions).ok).toBe(
      false,
    );
  });

  it("リプレイの出どころは sourceJobId か replayKey+game のどちらか一方", () => {
    const { replayKey: _replayKey, game: _game, ...noReplay } = ec2Request();
    expect(parseExperimentRequest(noReplay, regions).ok).toBe(false);
    expect(parseExperimentRequest({ ...noReplay, sourceJobId: "job-1" }, regions)).toMatchObject({
      ok: true,
      source: { sourceJobId: "job-1" },
    });
    expect(parseExperimentRequest({ ...noReplay, sourceJobId: "job-1", game: "th15" }, regions).ok).toBe(false);
    expect(parseExperimentRequest(ec2Request({ replayKey: "../etc/passwd" }), regions).ok).toBe(false);
  });
});

describe("buildExperimentJob", () => {
  const parsed = parseExperimentRequest(ec2Request(), regions);
  if (!parsed.ok) {
    throw new Error(parsed.message);
  }
  const job = buildExperimentJob({
    jobId: "exp-job",
    now: new Date("2026-11-21T00:00:00.000Z"),
    spec: parsed.spec,
    game: "th15",
    replayKey: REPLAY_KEY,
    replayInfo: null,
    estimatedDurationSeconds: 600,
    options: parsed.options,
  });

  it("queuedで作り、メールを持たず、段が計画を置き換える", () => {
    expect(job.status).toBe("queued");
    expect(job.email).toBeNull();
    expect(job.options.recordingSpeed).toBe(1 / 2);
    // th15の本番の段（GPU→CPU）ではなく、指定した1段だけ。
    expect(remainingRecordingSteps(job).map((step) => step.id)).toEqual(["experiment:cpu:eu-south-2"]);
    expect(remainingRecordingSteps({ ...job, capacityExhaustedTargets: ["experiment:cpu:eu-south-2"] })).toEqual(
      [],
    );
  });
});

describe("toExperimentResult", () => {
  it("実時間・尺比・推定コストをまとめる", () => {
    const parsed = parseExperimentRequest(ec2Request({ note: "n" }), regions);
    if (!parsed.ok) {
      throw new Error(parsed.message);
    }
    const job = createJobRecord({
      experiment: parsed.spec,
      status: "done",
      game: "th15",
      email: null,
      workerKind: "ec2",
      instanceType: "c7i.4xlarge",
      spotPricePerHour: 0.3,
      launchedAt: "2026-11-21T00:00:00.000Z",
      doneAt: "2026-11-21T00:20:00.000Z",
      estimatedDurationSeconds: 600,
      desyncDetected: false,
      timedOut: false,
      recordingStepId: "experiment:cpu:eu-south-2",
      options: { watermark: true, th10BugfixMarisaB: false, th06ncHighResolution: false, recordingSpeed: 1 / 2, captureMode: "realtime" },
    });
    const result = toExperimentResult(job, new Date("2026-11-21T01:00:00.000Z"));
    expect(result).toMatchObject({
      note: "n",
      workerImageTag: null,
      stepId: "experiment:cpu:eu-south-2",
      speed: 1 / 2,
      wallClockSeconds: 1200,
      wallClockToDurationRatio: 2,
      desyncDetected: false,
      timedOut: false,
      billedSeconds: 1200,
    });
    expect(result.estimatedCostUsd).toBeGreaterThan(0);
  });
});
