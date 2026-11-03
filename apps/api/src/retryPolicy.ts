/**
 * 録画ジョブの Launch タスク（Step Functions）のリトライ回数に関する定数。
 * startJob.ts（初回実行時の attempt シード）と sfn/handleFailure.ts
 * （リトライ可否判定）の両方から参照し、値が2ファイル間でズレないようにする。
 */
export const INITIAL_ATTEMPT = 1;

/**
 * 再試行に意味がありうる失敗（Spot中断・`States.Timeout`・クォータ超過等）の上限。
 * 最大10回試行（初回+リトライ9回）。Spot在庫の枯渇はここに含まれない——試せる段を
 * 使い切った時点で失敗させる（Issue #315、`docs/decisions/0063`）。
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

/**
 * `capacity_exhausted`のジョブに書くエラー文言（`errors.capacity_exhausted`の日本語版と同じ）。
 * Spot在庫の枯渇は数日続くことがあるため、すぐの再試行を促さない（Issue #315）。
 */
export const CAPACITY_EXHAUSTED_MESSAGE =
  "現在、録画サーバーの空きが不足しているため、録画を開始できませんでした。空きが戻るまで数時間から数日かかることがあります。時間をあけて再度お試しください";
