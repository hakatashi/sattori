import type { GameId } from "./games.js";
import { isGpuStep, recordingPlanFor } from "./recordingPlan.js";
import { isSlowMotionRecording, isSpeedupRecording, recordingSpeedOf } from "./recordingSpeed.js";

/**
 * GPUの要否は録画の段（`recordingPlan.ts`）が決める（Issue #317）。このファイルに残っているのは、
 * 段の導入前に書かれたジョブレコードを読むための型と、アップロード画面の推定時間が使う判定だけ。
 */

/**
 * 段の導入前（〜2026-11）に、GPUを確保できなかったジョブの速度を落とした理由。旧レコードの
 * `JobRecord.speedupFallbackReason`にだけ残っている（`docs/decisions/0060`・`0064`）。
 */
export const SPEEDUP_FALLBACK_REASONS = ["gpu_queue_wait", "gpu_capacity"] as const;
export type SpeedupFallbackReason = (typeof SPEEDUP_FALLBACK_REASONS)[number];

/**
 * 録画速度からGPUで録るかを推定する（アップロード画面の推定時間専用）。倍速、またはそのタイトルの
 * 段がGPUしか持たない速度（th15・th20・th06ncの等倍以上）ならGPU。低速はCPU。
 *
 * @deprecated 速度の選択UIの廃止（Issue #317）とともに削除する。起動側は段を見ること。
 */
export function requiresGpuRecording(job: {
  game: GameId;
  options?: { recordingSpeed?: unknown };
}): boolean {
  const speed = recordingSpeedOf(job.options);
  if (isSlowMotionRecording(speed)) {
    return false;
  }
  if (isSpeedupRecording(speed)) {
    return true;
  }
  return !recordingPlanFor(job.game).some((step) => !isGpuStep(step) && step.speed === speed);
}
