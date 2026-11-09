/**
 * 段の導入前（〜2026-11、Issue #317より前）に、GPUを確保できなかったジョブの速度を落とした理由。旧レコードの
 * `JobRecord.speedupFallbackReason`にだけ残っている（`docs/decisions/0060`・`0064`）。GPUの要否は録画の段
 * （`recordingPlan.ts`）が決める。
 */
export const SPEEDUP_FALLBACK_REASONS = ["gpu_queue_wait", "gpu_capacity"] as const;
export type SpeedupFallbackReason = (typeof SPEEDUP_FALLBACK_REASONS)[number];
