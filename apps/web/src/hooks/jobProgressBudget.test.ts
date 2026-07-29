import { describe, expect, it } from "vitest";
import {
  computeOverallPercent,
  computePhaseBudgets,
  computeRemainingMinutes,
  FALLBACK_ESTIMATED_DURATION_SECONDS,
  isPhaseOverrun,
  LAUNCHING_BUDGET_SECONDS,
  OVERALL_PROGRESS_CAP_PERCENT,
  PHASE_OVERRUN_FACTOR,
} from "./jobProgressBudget.ts";

describe("computePhaseBudgets", () => {
  it("estimatedDurationSecondsが分かっていればrecording/convertingをその値で見積もる", () => {
    const budgets = computePhaseBudgets(800);
    expect(budgets.launching).toBe(LAUNCHING_BUDGET_SECONDS);
    expect(budgets.recording).toBe(800);
    expect(budgets.converting).toBe(800);
    expect(budgets.total).toBe(LAUNCHING_BUDGET_SECONDS + 1600);
  });

  it("estimatedDurationSecondsがnullならフォールバック値を使う", () => {
    const budgets = computePhaseBudgets(null);
    expect(budgets.recording).toBe(FALLBACK_ESTIMATED_DURATION_SECONDS);
    expect(budgets.converting).toBe(FALLBACK_ESTIMATED_DURATION_SECONDS);
    expect(budgets.total).toBe(LAUNCHING_BUDGET_SECONDS + FALLBACK_ESTIMATED_DURATION_SECONDS * 2);
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
