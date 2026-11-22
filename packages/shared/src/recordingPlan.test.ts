import { afterEach, describe, expect, it } from "vitest";
import { SUPPORTED_GAME_IDS } from "./games.js";
import type { GameId } from "./games.js";
import {
  captureModeOf,
  currentRecordingStep,
  durationSkippedStepIds,
  GPU_FALLBACK_RECORDING_REGION,
  HOME_WORKER_GAME_IDS,
  initialCaptureMode,
  initialRecordingSpeed,
  isGpuStep,
  nextEc2Step,
  PRIMARY_RECORDING_REGION,
  RECORDING_PLANS,
  recordingPlanFor,
  recordingSpeedForStep,
  remainingRecordingSteps,
  skippableGpuStepIds,
} from "./recordingPlan.js";
import type { RecordingStep } from "./recordingPlan.js";

/** 段を「id 速度 候補」の1行に縮めて、表と突き合わせやすくする。 */
function describeStep(step: RecordingStep): string {
  const speed = step.captureMode === "frameSync" ? "fs" : `x${Number(step.speed.toFixed(3))}`;
  if (step.kind === "home") {
    return `home ${speed}`;
  }
  const extra = step.speedByDifficulty ? ` ${JSON.stringify(step.speedByDifficulty)}` : "";
  return `${step.id} ${speed} ${step.instanceTypes.join(",")}${extra}`;
}

describe("RECORDING_PLANS", () => {
  it("録画対応タイトルすべてに段がある", () => {
    for (const game of SUPPORTED_GAME_IDS) {
      expect(recordingPlanFor(game).length, game).toBeGreaterThan(0);
    }
  });

  it("録画非対応タイトルは段を持たない", () => {
    expect(recordingPlanFor("th14")).toEqual([]);
  });

  it("段のidはタイトルの中で一意", () => {
    for (const [game, steps] of Object.entries(RECORDING_PLANS)) {
      const ids = steps!.map((step) => step.id);
      expect(new Set(ids).size, game).toBe(ids.length);
    }
  });

  it("frameSyncの段は速度1固定で、フレーム同期へ切り替え済みのタイトルは先頭が自宅（Issue #387・#390）", () => {
    const frameSyncTitles: string[] = [];
    for (const [game, steps] of Object.entries(RECORDING_PLANS)) {
      for (const step of steps!) {
        if (step.captureMode === "frameSync") {
          expect(step.speed, `${game} ${step.id}`).toBe(1);
        }
      }
      if (steps!.some((step) => step.captureMode === "frameSync")) {
        frameSyncTitles.push(game);
        expect(steps![0]!.id, game).toBe("home");
        expect(steps![0]!.captureMode, game).toBe("frameSync");
      }
    }
    // 切り替え済み（Issue #390。th06nc・th20は順次）。
    expect(frameSyncTitles.sort()).toEqual([
      "th06",
      "th06c",
      "th07",
      "th08",
      "th09",
      "th10",
      "th11",
      "th12",
      "th128",
      "th13",
      "th15",
    ]);
  });

  it("frameSyncのEC2の段は実測した実時間効率（estimatedRealtimeFactor）を持つ", () => {
    for (const [game, steps] of Object.entries(RECORDING_PLANS)) {
      for (const step of steps!) {
        if (step.captureMode === "frameSync") {
          expect(step.estimatedRealtimeFactor, `${game} ${step.id}`).toBeGreaterThan(0);
        }
      }
    }
  });

  it("リージョンは一次リージョンか、GPUのフォールバック先（GPUの段のみ）", () => {
    for (const steps of Object.values(RECORDING_PLANS)) {
      for (const step of steps!) {
        if (step.kind !== "ec2") continue;
        if (step.platform === "gpu") {
          expect([PRIMARY_RECORDING_REGION, GPU_FALLBACK_RECORDING_REGION]).toContain(step.region);
        } else {
          expect(step.region).toBe(PRIMARY_RECORDING_REGION);
        }
      }
    }
  });

  // docs/reports/2026-11-08-recommended-speed-fallback-order-and-cost.md §1 の経路（Issue #317で
  // 速度の選択UIを廃止したとき、「おすすめ」を選んだときの経路をそのまま引き継いだ）。
  it.each<[GameId[], string[]]>([
    [
      // Issue #390・0078: 自宅 → .2xlarge帯 → c7i.4xlarge（どちらもフレーム同期）→ GPU（実時間2倍速。th07は3倍速）。
      ["th06", "th06c", "th08", "th09", "th10", "th11", "th12", "th128"],
      [
        "home fs",
        "cpu-fs-2xl:eu-south-2 fs c7i.2xlarge,c7a.2xlarge,m7i.2xlarge",
        "cpu-fs-4xl:eu-south-2 fs c7i.4xlarge",
        "gpu:eu-south-2 x2 g6f.2xlarge",
        "gpu:eu-north-1 x2 g6f.2xlarge",
      ],
    ],
    [
      ["th07"],
      [
        "home fs",
        "cpu-fs-2xl:eu-south-2 fs c7i.2xlarge,c7a.2xlarge,m7i.2xlarge",
        "cpu-fs-4xl:eu-south-2 fs c7i.4xlarge",
        "gpu:eu-south-2 x3 g6f.2xlarge",
        "gpu:eu-north-1 x3 g6f.2xlarge",
      ],
    ],
    [
      // 1280x960のタイトルは4xlarge帯が先、GPUの段は実時間の1倍速。
      ["th15"],
      [
        "home fs",
        "cpu-fs-4xl:eu-south-2 fs c7i.4xlarge",
        "cpu-fs-2xl:eu-south-2 fs c7i.2xlarge,c7a.2xlarge,m7i.2xlarge",
        "gpu:eu-south-2 x1 g6f.2xlarge",
        "gpu:eu-north-1 x1 g6f.2xlarge",
      ],
    ],
    [
      ["th20"],
      ["gpu:eu-south-2 x1 g6f.2xlarge", "gpu:eu-north-1 x1 g6f.2xlarge", "cpu:eu-south-2 x0.5 c7i.4xlarge"],
    ],
    [
      ["th06nc"],
      // Issue #317・touhou-recorder reports/97: `g6.2xlarge`の段をCPU（BC7展開）の1/2倍速に置き換えた（0067）。
      ["gpu:eu-south-2 x2 g6f.2xlarge", "gpu:eu-north-1 x2 g6f.2xlarge", "cpu:eu-south-2 x0.5 c7i.2xlarge"],
    ],
    [
      ["th13"],
      // GPUの段は持たない（GPUでの倍速は未検証、Issue #374）。
      [
        "home fs",
        "cpu-fs-2xl:eu-south-2 fs c7i.2xlarge,c7a.2xlarge,m7i.2xlarge",
        "cpu-fs-4xl:eu-south-2 fs c7i.4xlarge",
      ],
    ],
  ])("%j の段", (games, expected) => {
    for (const game of games) {
      expect(recordingPlanFor(game).map(describeStep), game).toEqual(expected);
    }
  });
});

describe("recordingSpeedForStep", () => {
  // th15のCPU低速録画は廃止したので、難易度ごとの上書き（`speedByDifficulty`）の仕組みだけを確かめる。
  const th15Cpu: RecordingStep = {
    id: "cpu:eu-south-2",
    kind: "ec2",
    platform: "cpu",
    region: PRIMARY_RECORDING_REGION,
    instanceTypes: ["c7i.4xlarge"],
    captureMode: "realtime",
    speed: 1 / 2,
    speedByDifficulty: { Extra: 1 / 3 },
  };

  it("難易度の上書きがあればそれを使う", () => {
    expect(recordingSpeedForStep(th15Cpu, { replayInfo: { difficulty: "Extra" } })).toBe(1 / 3);
  });

  it("難易度が一致しない・読めなければ段の速度", () => {
    expect(recordingSpeedForStep(th15Cpu, { replayInfo: { difficulty: "Lunatic" } })).toBe(1 / 2);
    expect(recordingSpeedForStep(th15Cpu, { replayInfo: { difficulty: null } })).toBe(1 / 2);
    expect(recordingSpeedForStep(th15Cpu, {})).toBe(1 / 2);
  });
});

describe("currentRecordingStep / remainingRecordingSteps", () => {
  it("使い切った段を飛ばす", () => {
    const job = { game: "th20" as const, capacityExhaustedTargets: ["gpu:eu-south-2", "gpu:eu-north-1"] };
    expect(currentRecordingStep(job)?.id).toBe("cpu:eu-south-2");
    expect(remainingRecordingSteps(job).map((step) => step.id)).toEqual(["cpu:eu-south-2"]);
  });

  it("除外条件の真の段を飛ばす", () => {
    expect(currentRecordingStep({ game: "th08" }, isGpuStep)?.id).toBe("home");
  });

  it("段の導入前に速度を落としたジョブ（requestedRecordingSpeed）はGPUの段へ戻らない", () => {
    expect(currentRecordingStep({ game: "th20", requestedRecordingSpeed: 1 })?.id).toBe("cpu:eu-south-2");
  });

  it("全段を使い切ったら null", () => {
    const job = {
      game: "th06nc" as const,
      capacityExhaustedTargets: ["gpu:eu-south-2", "gpu:eu-north-1", "cpu:eu-south-2"],
    };
    expect(currentRecordingStep(job)).toBeNull();
  });
});

describe("GPUの段を持たないタイトル（th13）", () => {
  it("最初の段は自宅ワーカーのフレーム同期で、2xlarge帯→4xlarge帯へ進む", () => {
    expect(currentRecordingStep({ game: "th13" })).toMatchObject({ id: "home", captureMode: "frameSync" });
    expect(initialRecordingSpeed({ game: "th13" })).toBe(1);
    const job = { game: "th13" as const, capacityExhaustedTargets: ["cpu-fs-2xl:eu-south-2"] };
    expect(remainingRecordingSteps(job).map((step) => step.id)).toEqual(["home", "cpu-fs-4xl:eu-south-2"]);
  });

  it("GPUの段が無いので飛ばすものも無い", () => {
    expect(skippableGpuStepIds({ game: "th13" })).toEqual([]);
  });
});

describe("skippableGpuStepIds", () => {
  it("GPU以外の段が後ろにあれば、残っているGPUの段を返す", () => {
    expect(skippableGpuStepIds({ game: "th20" })).toEqual(["gpu:eu-south-2", "gpu:eu-north-1"]);
    expect(skippableGpuStepIds({ game: "th20", capacityExhaustedTargets: ["gpu:eu-south-2"] })).toEqual([
      "gpu:eu-north-1",
    ]);
  });

  it("後ろのGPU以外の段を使い切っていれば飛ばせない", () => {
    expect(skippableGpuStepIds({ game: "th06nc", capacityExhaustedTargets: ["cpu:eu-south-2"] })).toEqual([]);
  });

  it("th06ncもCPUの段へ飛ばせる（Issue #317）", () => {
    expect(skippableGpuStepIds({ game: "th06nc" })).toEqual(["gpu:eu-south-2", "gpu:eu-north-1"]);
  });

  it("既にGPU以外の段にいれば飛ばすものは無い", () => {
    expect(
      skippableGpuStepIds({ game: "th20", capacityExhaustedTargets: ["gpu:eu-south-2", "gpu:eu-north-1"] }),
    ).toEqual([]);
  });
});

describe("initialRecordingSpeed", () => {
  it("最初の段の速度", () => {
    expect(initialRecordingSpeed({ game: "th08" })).toBe(1); // 先頭は自宅のフレーム同期
    expect(initialRecordingSpeed({ game: "th20" })).toBe(1);
    expect(initialRecordingSpeed({ game: "th06nc" })).toBe(2);
  });

  it("録画非対応タイトルは等倍", () => {
    expect(initialRecordingSpeed({ game: "th14" })).toBe(1);
  });
});

describe("HOME_WORKER_GAME_IDS", () => {
  it("自宅の段を持たないタイトル（th06nc・th20）を含まず、GPUの段を持つth15も含む（0079）", () => {
    expect(HOME_WORKER_GAME_IDS).not.toContain("th06nc");
    expect(HOME_WORKER_GAME_IDS).toContain("th15");
    expect(HOME_WORKER_GAME_IDS).not.toContain("th20");
    expect(HOME_WORKER_GAME_IDS).toContain("th08");
    expect(HOME_WORKER_GAME_IDS).toContain("th13");
  });
});


/** 「自宅 → CPU(frameSync) ×2 → GPU」。GPUの段が最後に来る新しい計画（Epic #399）の架空版。 */
const FRAME_SYNC_PLAN: readonly RecordingStep[] = [
  { id: "home", kind: "home", captureMode: "frameSync", speed: 1 },
  {
    id: "cpu-fs-2xl:eu-south-2",
    kind: "ec2",
    platform: "cpu",
    region: PRIMARY_RECORDING_REGION,
    instanceTypes: ["c7i.2xlarge"],
    captureMode: "frameSync",
    speed: 1,
    maxEstimatedDurationSeconds: 55 * 60,
    estimatedRealtimeFactor: 1.2,
  },
  {
    id: "cpu-fs-4xl:eu-south-2",
    kind: "ec2",
    platform: "cpu",
    region: PRIMARY_RECORDING_REGION,
    instanceTypes: ["c7i.4xlarge"],
    captureMode: "frameSync",
    speed: 1,
  },
  {
    id: "gpu:eu-south-2",
    kind: "ec2",
    platform: "gpu",
    region: PRIMARY_RECORDING_REGION,
    instanceTypes: ["g6f.2xlarge"],
    captureMode: "realtime",
    speed: 2,
  },
];

describe("GPUの段が最後にある計画（Issue #387）", () => {
  const plans = RECORDING_PLANS as Partial<Record<GameId, readonly RecordingStep[]>>;
  const original = plans.th12;
  afterEach(() => {
    plans.th12 = original;
  });

  it("nextEc2Stepは自宅の段を飛ばして次のEC2の段を返す", () => {
    plans.th12 = FRAME_SYNC_PLAN;
    expect(currentRecordingStep({ game: "th12" })?.id).toBe("home");
    expect(nextEc2Step({ game: "th12" })?.id).toBe("cpu-fs-2xl:eu-south-2");
    expect(
      nextEc2Step({ game: "th12", capacityExhaustedTargets: ["cpu-fs-2xl:eu-south-2", "cpu-fs-4xl:eu-south-2"] })?.id,
    ).toBe("gpu:eu-south-2");
    expect(
      nextEc2Step({
        game: "th12",
        capacityExhaustedTargets: ["cpu-fs-2xl:eu-south-2", "cpu-fs-4xl:eu-south-2", "gpu:eu-south-2"],
      }),
    ).toBeNull();
  });

  it("GPUの段が最後なら、後ろに段が無いのでskippableGpuStepIdsは空（自宅の段へは戻らない）", () => {
    plans.th12 = FRAME_SYNC_PLAN;
    const exhaustedCpu = ["cpu-fs-2xl:eu-south-2", "cpu-fs-4xl:eu-south-2"];
    expect(skippableGpuStepIds({ game: "th12", capacityExhaustedTargets: exhaustedCpu })).toEqual([]);
    // CPUの段が残っているうちは、次のEC2の段がGPUでないので飛ばす対象ではない。
    expect(skippableGpuStepIds({ game: "th12" })).toEqual([]);
  });

  it("GPUの段が先頭の計画では従来どおり、後ろにGPU以外の段があれば飛ばせる", () => {
    plans.th12 = [FRAME_SYNC_PLAN[3]!, FRAME_SYNC_PLAN[0]!, FRAME_SYNC_PLAN[2]!];
    expect(skippableGpuStepIds({ game: "th12" })).toEqual(["gpu:eu-south-2"]);
  });

  it("推定尺がmaxEstimatedDurationSecondsを超える段は残りの段から外れる", () => {
    plans.th12 = FRAME_SYNC_PLAN;
    const long = { game: "th12", estimatedDurationSeconds: 56 * 60 } as const;
    expect(remainingRecordingSteps(long).map((step) => step.id)).toEqual([
      "home",
      "cpu-fs-4xl:eu-south-2",
      "gpu:eu-south-2",
    ]);
    expect(durationSkippedStepIds(long)).toEqual(["cpu-fs-2xl:eu-south-2"]);
    // 記録済みなら重複して返さない。
    expect(
      durationSkippedStepIds({ ...long, capacityExhaustedTargets: ["cpu-fs-2xl:eu-south-2"] }),
    ).toEqual([]);
  });

  it("上限ちょうど・推定尺が不明のジョブは段を飛ばさない", () => {
    plans.th12 = FRAME_SYNC_PLAN;
    expect(remainingRecordingSteps({ game: "th12", estimatedDurationSeconds: 55 * 60 })).toHaveLength(4);
    expect(remainingRecordingSteps({ game: "th12", estimatedDurationSeconds: null })).toHaveLength(4);
    expect(remainingRecordingSteps({ game: "th12" })).toHaveLength(4);
  });

  it("captureModeOf・initialCaptureMode", () => {
    expect(captureModeOf(undefined)).toBe("realtime");
    expect(captureModeOf({ captureMode: "frameSync" })).toBe("frameSync");
    expect(captureModeOf({ captureMode: "bogus" })).toBe("realtime");
    plans.th12 = FRAME_SYNC_PLAN;
    expect(initialCaptureMode({ game: "th12" })).toBe("frameSync");
    expect(initialRecordingSpeed({ game: "th12" })).toBe(1);
  });
});

describe("th12・th15のフレーム同期の計画（Issue #390）", () => {
  it("th15の2xlarge段だけ、推定尺が約55分を超えるジョブは飛ばす（th12は飛ばさない）", () => {
    expect(durationSkippedStepIds({ game: "th15", estimatedDurationSeconds: 3301 })).toEqual([
      "cpu-fs-2xl:eu-south-2",
    ]);
    expect(durationSkippedStepIds({ game: "th15", estimatedDurationSeconds: 3300 })).toEqual([]);
    expect(durationSkippedStepIds({ game: "th12", estimatedDurationSeconds: 4000 })).toEqual([]);
  });

  it("最初の段は自宅ワーカーのフレーム同期で、GPUの段は最後（後ろのGPU以外の段が無いので飛ばせない）", () => {
    for (const game of ["th12", "th15"] as const) {
      expect(currentRecordingStep({ game })).toMatchObject({ id: "home", captureMode: "frameSync" });
      expect(initialCaptureMode({ game })).toBe("frameSync");
      expect(initialRecordingSpeed({ game })).toBe(1);
      expect(skippableGpuStepIds({ game })).toEqual([]);
    }
  });

  it("th15のGPUの段は実時間の1倍速、th12は2倍速", () => {
    expect(recordingPlanFor("th15").filter(isGpuStep).map((step) => step.speed)).toEqual([1, 1]);
    expect(recordingPlanFor("th12").filter(isGpuStep).map((step) => step.speed)).toEqual([2, 2]);
  });
});
