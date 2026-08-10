import { describe, expect, it } from "vitest";
import {
  computeOverallPercent,
  computePhaseBudgets,
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

describe("computePhaseBudgets（低速録画、Issue #68）", () => {
  it("録画フェーズの悲観バジェットは実時間で2倍になる", () => {
    const budgets = computePhaseBudgets(900, true);

    expect(budgets.recording).toBe(1800);
    // 変換の対象は等倍へ戻した後の動画なので、尺は低速録画でも変わらない。
    expect(budgets.converting).toBe(300);
    expect(budgets.total).toBe(LAUNCHING_BUDGET_SECONDS + 1800 + 300);
  });

  it("recordingContent はコンテンツ長のままで、低速録画かどうかに依らない", () => {
    // ワーカーが報告する progress はコンテンツ秒数なので、実時間の recording と
    // 直接比べてはいけない。この値が両者の換算係数・分母になる。
    expect(computePhaseBudgets(900, true).recordingContent).toBe(900);
    expect(computePhaseBudgets(900, false).recordingContent).toBe(900);
  });

  it("既定(引数省略)は等倍録画として計算する", () => {
    expect(computePhaseBudgets(900)).toEqual(computePhaseBudgets(900, false));
  });

  it("低速録画の録画バジェットは、リトライ疑いの誤検知を防ぐのに十分な余裕がある", () => {
    // 悲観バジェットの PHASE_OVERRUN_FACTOR 倍を超えるとリトライ疑いになる。
    // 等倍のバジェットのままだと、2倍かかる録画は必ずこれを踏む。
    const naive = computePhaseBudgets(900, false).recording;
    const actualWallClock = 900 * 2;

    expect(isPhaseOverrun(naive, actualWallClock)).toBe(true);
    expect(isPhaseOverrun(computePhaseBudgets(900, true).recording, actualWallClock)).toBe(false);
  });
});
