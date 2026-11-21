import { PRIMARY_RECORDING_REGION, RECORDING_PLANS } from "@sattori/shared";
import type { GameId, RecordingStep } from "@sattori/shared";

/**
 * 「自宅 → CPU(frameSync) ×2 → GPU」の架空の計画（Epic #399、Issue #387）。GPUの段が最後に来る新しい
 * 計画をテストするため。実際のタイトルへの割り当ては#390で行うので、テストは`RECORDING_PLANS`の
 * 一時的な差し替え（`useFrameSyncPlan()`）で確かめる。
 */
export const FRAME_SYNC_PLAN: readonly RecordingStep[] = [
  { id: "home", kind: "home", captureMode: "frameSync", speed: 1 },
  {
    id: "cpu-fs-2xl:eu-south-2",
    kind: "ec2",
    platform: "cpu",
    region: PRIMARY_RECORDING_REGION,
    instanceTypes: ["c7i.2xlarge"],
    captureMode: "frameSync",
    speed: 1,
    maxEstimatedDurationSeconds: 55 * 60,
  },
  {
    id: "cpu-fs-4xl:eu-south-2",
    kind: "ec2",
    platform: "cpu",
    region: PRIMARY_RECORDING_REGION,
    instanceTypes: ["c7i.4xlarge"],
    captureMode: "frameSync",
    speed: 1,
  },
  {
    id: "gpu:eu-south-2",
    kind: "ec2",
    platform: "gpu",
    region: PRIMARY_RECORDING_REGION,
    instanceTypes: ["g6f.2xlarge"],
    captureMode: "realtime",
    speed: 2,
  },
];

/** `game`の計画を架空の計画へ差し替え、元へ戻す関数を返す（`afterEach`で呼ぶ）。 */
export function useFrameSyncPlan(game: GameId): () => void {
  const plans = RECORDING_PLANS as Partial<Record<GameId, readonly RecordingStep[]>>;
  const original = plans[game];
  plans[game] = FRAME_SYNC_PLAN;
  return () => {
    plans[game] = original;
  };
}
