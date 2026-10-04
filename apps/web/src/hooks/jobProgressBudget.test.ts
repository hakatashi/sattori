import { describe, expect, it } from "vitest";
import {
  computeOverallPercent,
  computePhaseBudgets,
  recordingScaleForJob,
  computeRemainingMinutes,
  FALLBACK_ESTIMATED_DURATION_SECONDS,
  isPhaseOverrun,
  LAUNCHING_BUDGET_SECONDS,
  MIN_CONVERTING_RATE,
  OVERALL_PROGRESS_CAP_PERCENT,
  PHASE_OVERRUN_FACTOR,
} from "./jobProgressBudget.ts";

describe("computePhaseBudgets", () => {
  it("estimatedDurationSecondsが分かっていればrecordingはその値、convertingはMIN_CONVERTING_RATE分の1(recordingの1/3の長さ)で見積もる", () => {
    const budgets = computePhaseBudgets(900);
    expect(budgets.launching).toBe(LAUNCHING_BUDGET_SECONDS);
    expect(budgets.recording).toBe(900);
    expect(budgets.converting).toBe(300);
    expect(budgets.total).toBe(LAUNCHING_BUDGET_SECONDS + 900 + 300);
  });

  it("estimatedDurationSecondsがnullならフォールバック値を使う", () => {
    const budgets = computePhaseBudgets(null);
    expect(budgets.recording).toBe(FALLBACK_ESTIMATED_DURATION_SECONDS);
    expect(budgets.converting).toBe(FALLBACK_ESTIMATED_DURATION_SECONDS / MIN_CONVERTING_RATE);
    expect(budgets.total).toBe(
      LAUNCHING_BUDGET_SECONDS +
        FALLBACK_ESTIMATED_DURATION_SECONDS +
        FALLBACK_ESTIMATED_DURATION_SECONDS / MIN_CONVERTING_RATE,
    );
  });
});

describe("computeOverallPercent", () => {
  it("経過0秒なら0%", () => {
    expect(computeOverallPercent(0, 1000, false)).toBe(0);
  });

  it("バジェットちょうどでも未完了ならキャップ(99%)でクランプされる", () => {
    expect(computeOverallPercent(1000, 1000, false)).toBe(OVERALL_PROGRESS_CAP_PERCENT);
  });

  it("バジェットを超過してもキャップ(99%)を超えない", () => {
    expect(computeOverallPercent(5000, 1000, false)).toBe(OVERALL_PROGRESS_CAP_PERCENT);
  });

  it("doneならバジェットの過不足に関わらず常に100%", () => {
    expect(computeOverallPercent(0, 1000, true)).toBe(100);
    expect(computeOverallPercent(5000, 1000, true)).toBe(100);
  });

  it("totalBudgetSecondsが0以下なら0%", () => {
    expect(computeOverallPercent(100, 0, false)).toBe(0);
  });
});

describe("computeRemainingMinutes", () => {
  it("端数は切り上げる", () => {
    expect(computeRemainingMinutes(0, 61)).toBe(2);
  });

  it("残り0秒ちょうどならnull", () => {
    expect(computeRemainingMinutes(1000, 1000)).toBeNull();
  });

  it("バジェットを超過していればnull", () => {
    expect(computeRemainingMinutes(1500, 1000)).toBeNull();
  });

  it("ごく僅かに残っている場合でも最小1分になる", () => {
    expect(computeRemainingMinutes(995, 1000)).toBe(1);
  });
});

describe("isPhaseOverrun", () => {
  it("バジェット未設定(null)ならfalse", () => {
    expect(isPhaseOverrun(null, 10_000)).toBe(false);
  });

  it("PHASE_OVERRUN_FACTOR未満ならfalse", () => {
    expect(isPhaseOverrun(100, 100 * PHASE_OVERRUN_FACTOR)).toBe(false);
  });

  it("PHASE_OVERRUN_FACTORを超えたらtrue", () => {
    expect(isPhaseOverrun(100, 100 * PHASE_OVERRUN_FACTOR + 1)).toBe(true);
  });
});

describe("computePhaseBudgets（録画スケール）", () => {
  it("recordingContent は録画スケールに依らずコンテンツ長のまま", () => {
    // ワーカーが報告する progress はコンテンツ秒数なので、実時間の recording と
    // 直接比べてはいけない。この値が両者の換算係数・分母になる。
    expect(computePhaseBudgets(900, 0.5).recordingContent).toBe(900);
    expect(computePhaseBudgets(900, 1).recordingContent).toBe(900);
  });

  it("既定(引数省略)は等倍録画として計算する", () => {
    expect(computePhaseBudgets(900)).toEqual(computePhaseBudgets(900, 1));
  });
});

describe("recordingScaleForJob（倍速録画、Issue #288）", () => {
  it("等倍は1", () => {
    expect(recordingScaleForJob({ recordingSpeed: 1 })).toBe(1);
  });

  it("倍速録画は約1/N(実時間で進む区間のぶん少し長め)", () => {
    expect(recordingScaleForJob({ recordingSpeed: 2 })).toBeCloseTo(0.525);
    expect(recordingScaleForJob({ recordingSpeed: 4 })).toBeCloseTo(0.2625);
  });

  it("倍速録画の録画バジェットは短くなるが、変換バジェットは尺のまま", () => {
    const native = computePhaseBudgets(900, 1);
    const speedup = computePhaseBudgets(900, recordingScaleForJob({ recordingSpeed: 3 }));
    expect(speedup.recording).toBeLessThan(native.recording / 2);
    expect(speedup.recordingContent).toBe(900);
    expect(speedup.converting).toBe(native.converting);
  });
});
