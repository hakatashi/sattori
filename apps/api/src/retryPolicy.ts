/**
 * 録画ジョブの Launch タスク（Step Functions）のリトライ回数に関する定数。
 * startJob.ts（初回実行時の attempt シード）と sfn/handleFailure.ts
 * （リトライ可否判定）の両方から参照し、値が2ファイル間でズレないようにする。
 */
export const INITIAL_ATTEMPT = 1;

/** 最大10回試行（初回+リトライ9回）。Spotキャパシティ不足等が数分で解消することを見込む。 */
export const MAX_ATTEMPTS = 10;
