import { isTerminalStatus, STALLED_JOB_THRESHOLD_MINUTES } from "@sattori/shared";
import type { JobStatus } from "@sattori/shared";
import type { ExecutionLiveness } from "./stepFunctions.js";

/**
 * 非終端のまま固まったジョブの検知ロジック（Issue #132）。AWS APIを呼ばない
 * 純粋関数だけをここに置き、実際の走査と`failed`への確定は
 * `handlers/sweepStalledJobs.ts` が行う（`orphanInstances.ts`と同じ分離）。
 *
 * 固まる経路は複数ある（起動直後にLambdaが死ぬ・後始末ハンドラ自体が例外を握り潰す・
 * 緊急停止のterminateが失敗する等、AGENTS.md参照）が、どれも最終的に「非終端のまま
 * ジョブレコードが取り残される」という同じ結末に収束する。個々の経路を塞ぐより、
 * この結末そのものを定期的に検知して`failed`へ倒す安全網の方が効く。
 */

/** 猶予（ミリ秒）。`STALLED_JOB_THRESHOLD_MINUTES`の単位を揃えただけのもの。 */
export const STALLED_JOB_THRESHOLD_MS = STALLED_JOB_THRESHOLD_MINUTES * 60 * 1000;

export interface IsStalledJobInput {
  status: JobStatus;
  /** ISO 8601。`JobRecord.updatedAt`。 */
  updatedAt: string;
  /** そのジョブのStep Functions実行の生死（`stepFunctions.ts`）。 */
  executionLiveness: ExecutionLiveness;
  now: Date;
  /** テスト用の上書き。既定は `STALLED_JOB_THRESHOLD_MS`。 */
  thresholdMs?: number;
}

/**
 * ジョブが「非終端のまま固まった」と判定してよいか。
 *
 * - 既に終端状態（`done`/`failed`）なら対象外。
 * - `pending`も対象外（**非終端だがStep Functionsの実行自体がまだ無いのが正常**な
 *   状態）。マジックリンクを24時間開かないユーザーは珍しくなく、これを固まったと
 *   誤判定すると、単にリンクを開いていないだけのジョブを問答無用で`failed`にしてしまう
 *   （`pendingExpiresAt`による受付期限切れの判定は`startJob.ts`側に別途ある）。
 * - Step Functions実行が生きている（`running`）なら、`updatedAt`がどれだけ古くても
 *   対象外にする。リトライで実際の所要時間が`STALLED_JOB_THRESHOLD_MINUTES`を
 *   超えることは正常にありうるため、判定の主たる根拠は`orphanInstances.ts`と同じく
 *   常に実行の生死である（statusを代理条件にしてはならない理由は`stepFunctions.ts`
 *   の`getExecutionLiveness`参照）。
 * - `updatedAt`が不正な値で読めない場合は安全側（対象外）に倒す。
 */
export function isStalledJob({
  status,
  updatedAt,
  executionLiveness,
  now,
  thresholdMs = STALLED_JOB_THRESHOLD_MS,
}: IsStalledJobInput): boolean {
  if (isTerminalStatus(status) || status === "pending") {
    return false;
  }
  if (executionLiveness === "running") {
    return false;
  }
  const updatedAtMs = new Date(updatedAt).getTime();
  if (Number.isNaN(updatedAtMs)) {
    return false;
  }
  return now.getTime() - updatedAtMs >= thresholdMs;
}
