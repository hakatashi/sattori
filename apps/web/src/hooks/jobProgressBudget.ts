/**
 * launching(EC2 Spot起動〜ワーカー起動完了)の悲観的所要時間の仮置き値。
 * 実測データが無いための暫定値。運用データが溜まったら見直す。
 */
export const LAUNCHING_BUDGET_SECONDS = 5 * 60;

/**
 * estimatedDurationSeconds が不明(旧ジョブ・解析失敗等)な場合の全体バー目盛り用フォールバック。
 * 根拠のある実測値ではないため、この値使用時は「残り約○分」テキストは出さない。
 */
export const FALLBACK_ESTIMATED_DURATION_SECONDS = 10 * 60;

/**
 * converting の悲観的下限速度(等倍)。useEstimatedProgress.ts と共有するためここに集約する。
 */
export const MIN_CONVERTING_RATE = 1;

/** done になるまで到達させない上限(%)。悲観バジェットぴったりで converting が終わっても、
 *  status がまだ converting のまま100%表示になって混乱を招くのを避けるため。 */
export const OVERALL_PROGRESS_CAP_PERCENT = 99;

/** 現フェーズの経過がバジェットの何倍を超えたらリトライ疑いとするかの係数。 */
export const PHASE_OVERRUN_FACTOR = 1.5;

export interface PhaseBudgets {
  launching: number;
  recording: number;
  converting: number;
  total: number;
}

/**
 * ジョブ全体(launching + recording + converting)の悲観的な合計所要時間(秒)を計算する。
 * recording/converting はいずれも最悪ケース(等倍速)を仮定するため同じ値になる。
 */
export function computePhaseBudgets(estimatedDurationSeconds: number | null): PhaseBudgets {
  const perPhase = estimatedDurationSeconds ?? FALLBACK_ESTIMATED_DURATION_SECONDS;
  return {
    launching: LAUNCHING_BUDGET_SECONDS,
    recording: perPhase,
    converting: perPhase,
    total: LAUNCHING_BUDGET_SECONDS + perPhase * 2,
  };
}

export function computeOverallPercent(
  elapsedSeconds: number,
  totalBudgetSeconds: number,
  done: boolean,
): number {
  if (done) {
    return 100;
  }
  if (totalBudgetSeconds <= 0) {
    return 0;
  }
  const raw = (elapsedSeconds / totalBudgetSeconds) * 100;
  return Math.min(OVERALL_PROGRESS_CAP_PERCENT, Math.max(0, raw));
}

/** 残り分数(切り上げ)。バジェットを使い切っていれば null(残り時間を主張しない)。 */
export function computeRemainingMinutes(
  elapsedSeconds: number,
  totalBudgetSeconds: number,
): number | null {
  const remaining = totalBudgetSeconds - elapsedSeconds;
  if (remaining <= 0) {
    return null;
  }
  return Math.max(1, Math.ceil(remaining / 60));
}

export function isPhaseOverrun(budgetForPhase: number | null, elapsedInPhase: number): boolean {
  return budgetForPhase !== null && elapsedInPhase > budgetForPhase * PHASE_OVERRUN_FACTOR;
}
