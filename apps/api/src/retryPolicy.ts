/**
 * 録画ジョブの Launch タスク（Step Functions）のリトライ回数に関する定数。
 * startJob.ts（初回実行時の attempt シード）と sfn/handleFailure.ts
 * （リトライ可否判定）の両方から参照し、値が2ファイル間でズレないようにする。
 */
export const INITIAL_ATTEMPT = 1;

/**
 * 再試行に意味がありうる失敗（Spot中断・`States.Timeout`・EC2起動時のキャパシティ
 * 不足等）の上限。最大10回試行（初回+リトライ9回）。Spotキャパシティ不足等が
 * 数分で解消することを見込む。
 */
export const MAX_ATTEMPTS = 10;

/**
 * 再試行しても解決しない「決定的な失敗」（`WorkerFailed`（Spot中断を除く）・
 * `WorkerBootstrapFailure`）の上限（Issue #131）。デシンク等が原因の失敗は同一
 * リプレイなら毎回同じ箇所で再現するため（`worker/README.md` §13）、フルの
 * `MAX_ATTEMPTS` まで試行時間（1回あたり最大150分の taskTimeout + 3分の待機）を
 * 浪費させず早期に打ち切る。最大3回試行（初回+リトライ2回）。
 */
export const MAX_ATTEMPTS_DETERMINISTIC = 3;
