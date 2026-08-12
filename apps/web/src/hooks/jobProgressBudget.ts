import { recordingWallClockScale } from "@sattori/shared";

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
 * converting の悲観的下限速度。recordingの1/3の長さ(3倍速)で終わることを最悪ケースとする。
 * useEstimatedProgress.ts のフェーズ内速度クランプの下限とも共有するためここに集約する。
 */
export const MIN_CONVERTING_RATE = 3;

/** done になるまで到達させない上限(%)。悲観バジェットぴったりで converting が終わっても、
 *  status がまだ converting のまま100%表示になって混乱を招くのを避けるため。 */
export const OVERALL_PROGRESS_CAP_PERCENT = 99;

/** 現フェーズの経過がバジェットの何倍を超えたらリトライ疑いとするかの係数。 */
export const PHASE_OVERRUN_FACTOR = 1.5;

export interface PhaseBudgets {
  launching: number;
  /** 録画フェーズの悲観バジェット(秒、**実時間**)。低速録画なら等倍の2倍になる。 */
  recording: number;
  /**
   * 録画されるコンテンツの長さ(秒) = リプレイの再生時間。ワーカーが報告する進捗
   * (`GetJobResponse.progress`)は**実時間ではなくコンテンツ秒数**なので、
   * `recording`(実時間)と直接比べてはいけない。両者を突き合わせる箇所は
   * この値を分母／換算係数として使う。低速録画かどうかに依らず一定。
   */
  recordingContent: number;
  converting: number;
  total: number;
}

/**
 * ジョブ全体(launching + recording + converting)の悲観的な合計所要時間(秒)を計算する。
 *
 * recording はリプレイを再生しながら録画するので、通常はリプレイの再生時間そのもの
 * (等倍)。ただし低速録画(Issue #68)ではゲームを1/2倍速で走らせるため、同じ
 * リプレイでも実時間では `SLOW_MOTION_TIME_SCALE` 倍かかる。**これを織り込まないと、
 * th20の低速録画は録画フェーズの途中でバジェットを使い切り、「残り約○分」が消えた上に
 * `isPhaseOverrun()` がリトライ疑いを誤検知する**(悲観バジェットの1.5倍＝等倍換算
 * 1.5倍を、2倍かかる録画は必ず超えるため)。
 *
 * converting は録画結果(等倍に戻した後の動画)に対する処理なので、低速録画でも
 * 尺は変わらない——スケールしてはいけない。最悪ケースでも MIN_CONVERTING_RATE 倍速
 * (recordingの1/3の長さ)で終わることを仮定する。
 */
export function computePhaseBudgets(
  estimatedDurationSeconds: number | null,
  slowMotion = false,
): PhaseBudgets {
  const perPhase = estimatedDurationSeconds ?? FALLBACK_ESTIMATED_DURATION_SECONDS;
  const recording = perPhase * recordingWallClockScale(slowMotion);
  const converting = perPhase / MIN_CONVERTING_RATE;
  return {
    launching: LAUNCHING_BUDGET_SECONDS,
    recording,
    recordingContent: perPhase,
    converting,
    total: LAUNCHING_BUDGET_SECONDS + recording + converting,
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
