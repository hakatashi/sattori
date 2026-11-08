import { describe, expect, it } from "vitest";
import { SUPPORTED_GAME_IDS } from "./games.js";
import type { GameId } from "./games.js";
import {
  currentRecordingStep,
  GPU_FALLBACK_RECORDING_REGION,
  HOME_WORKER_GAME_IDS,
  initialRecordingSpeed,
  isGpuStep,
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
  if (step.kind === "home") {
    return `home x${step.speed}`;
  }
  const extra = step.speedByDifficulty ? ` ${JSON.stringify(step.speedByDifficulty)}` : "";
  return `${step.id} x${Number(step.speed.toFixed(3))} ${step.instanceTypes.join(",")}${extra}`;
}

describe("RECORDING_PLANS", () => {
  it("録画対応タイトルすべてに段がある", () => {
    for (const game of SUPPORTED_GAME_IDS) {
      expect(recordingPlanFor(game).length, game).toBeGreaterThan(0);
    }
  });

  it("録画非対応タイトルは段を持たない", () => {
    expect(recordingPlanFor("th13")).toEqual([]);
  });

  it("段のidはタイトルの中で一意", () => {
    for (const [game, steps] of Object.entries(RECORDING_PLANS)) {
      const ids = steps!.map((step) => step.id);
      expect(new Set(ids).size, game).toBe(ids.length);
    }
  });

  it("GPUの段はGPU以外の段より前にある（GPUリースの確保・返却の前提）", () => {
    for (const [game, steps] of Object.entries(RECORDING_PLANS)) {
      const firstNonGpu = steps!.findIndex((step) => !isGpuStep(step));
      if (firstNonGpu !== -1) {
        expect(steps!.slice(firstNonGpu).some(isGpuStep), game).toBe(false);
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
      ["th06", "th06c", "th08", "th09", "th10"],
      [
        "gpu:eu-south-2 x2 g6f.2xlarge",
        "gpu:eu-north-1 x2 g6f.2xlarge",
        "home x1",
        "cpu:eu-south-2 x1 c7i.xlarge,c7a.xlarge,c7i-flex.xlarge,m7i.xlarge",
      ],
    ],
    [
      ["th07"],
      [
        "gpu:eu-south-2 x3 g6f.2xlarge",
        "gpu:eu-north-1 x3 g6f.2xlarge",
        "home x1",
        "cpu:eu-south-2 x1 c7i.xlarge,c7a.xlarge,c7i-flex.xlarge,m7i.xlarge",
      ],
    ],
    [
      ["th11", "th12", "th128"],
      [
        "gpu:eu-south-2 x2 g6f.2xlarge",
        "gpu:eu-north-1 x2 g6f.2xlarge",
        "home x1",
        "cpu:eu-south-2 x1 c7i.2xlarge,c7a.2xlarge,m7i.2xlarge",
      ],
    ],
    [
      ["th15"],
      [
        "gpu:eu-south-2 x2 g6f.2xlarge",
        "gpu:eu-north-1 x2 g6f.2xlarge",
        'cpu:eu-south-2 x0.5 c7i.4xlarge {"Extra":0.3333333333333333}',
      ],
    ],
    [
      ["th20"],
      ["gpu:eu-south-2 x1 g6f.2xlarge", "gpu:eu-north-1 x1 g6f.2xlarge", "cpu:eu-south-2 x0.5 c7i.4xlarge"],
    ],
    [
      ["th06nc"],
      ["gpu:eu-south-2 x2 g6f.2xlarge", "gpu:eu-north-1 x2 g6f.2xlarge", "gpu-full:eu-south-2 x2 g6.2xlarge"],
    ],
  ])("%j の段", (games, expected) => {
    for (const game of games) {
      expect(recordingPlanFor(game).map(describeStep), game).toEqual(expected);
    }
  });
});

describe("recordingSpeedForStep", () => {
  const th15Cpu = recordingPlanFor("th15")[2]!;

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
    const job = { game: "th08" as const, capacityExhaustedTargets: ["gpu:eu-south-2", "gpu:eu-north-1"] };
    expect(currentRecordingStep(job)?.id).toBe("home");
    expect(remainingRecordingSteps(job).map((step) => step.id)).toEqual(["home", "cpu:eu-south-2"]);
  });

  it("除外条件の真の段を飛ばす", () => {
    expect(currentRecordingStep({ game: "th08" }, isGpuStep)?.id).toBe("home");
  });

  it("全段を使い切ったら null", () => {
    const job = {
      game: "th06nc" as const,
      capacityExhaustedTargets: ["gpu:eu-south-2", "gpu:eu-north-1", "gpu-full:eu-south-2"],
    };
    expect(currentRecordingStep(job)).toBeNull();
  });
});

describe("skippableGpuStepIds", () => {
  it("GPU以外の段が後ろにあれば、残っているGPUの段を返す", () => {
    expect(skippableGpuStepIds({ game: "th08" })).toEqual(["gpu:eu-south-2", "gpu:eu-north-1"]);
    expect(skippableGpuStepIds({ game: "th20", capacityExhaustedTargets: ["gpu:eu-south-2"] })).toEqual([
      "gpu:eu-north-1",
    ]);
  });

  it("GPU以外の段が無いタイトル（th06nc）は飛ばせない", () => {
    expect(skippableGpuStepIds({ game: "th06nc" })).toEqual([]);
  });

  it("既にGPU以外の段にいれば飛ばすものは無い", () => {
    expect(
      skippableGpuStepIds({ game: "th08", capacityExhaustedTargets: ["gpu:eu-south-2", "gpu:eu-north-1"] }),
    ).toEqual([]);
  });
});

describe("initialRecordingSpeed", () => {
  it("最初の段の速度", () => {
    expect(initialRecordingSpeed({ game: "th08" })).toBe(2);
    expect(initialRecordingSpeed({ game: "th07" })).toBe(3);
    expect(initialRecordingSpeed({ game: "th20" })).toBe(1);
  });

  it("録画非対応タイトルは等倍", () => {
    expect(initialRecordingSpeed({ game: "th13" })).toBe(1);
  });
});

describe("HOME_WORKER_GAME_IDS", () => {
  it("GPU以外で録れないタイトルと低速録画のタイトルを含まない", () => {
    expect(HOME_WORKER_GAME_IDS).not.toContain("th06nc");
    expect(HOME_WORKER_GAME_IDS).not.toContain("th15");
    expect(HOME_WORKER_GAME_IDS).not.toContain("th20");
    expect(HOME_WORKER_GAME_IDS).toContain("th08");
  });
});
