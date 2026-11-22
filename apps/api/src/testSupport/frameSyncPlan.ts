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

/**
 * 「GPU（実時間の倍速）→ 自宅（実時間・等倍）→ CPU（実時間・等倍）」の計画。#390でth06〜th13がフレーム同期へ
 * 切り替わるまで、th06・th06c・th07・th08・th09・th10がこの形だった。GPUの段が先頭にある計画の汎用的な挙動
 * （GPU枠の待ち・飛ばし、自宅へのオファー、CPUの段への降格）はまだth06nc・th20以外では本物のタイトルで
 * 確かめられないので、テストでは`RECORDING_PLANS`を一時的に差し替えて確かめる。
 */
export function legacyGpuFirstPlan(gpuSpeed: 2 | 3): readonly RecordingStep[] {
  const gpu = (region: string): RecordingStep => ({
    id: `gpu:${region}`,
    kind: "ec2",
    platform: "gpu",
    region,
    instanceTypes: ["g6f.2xlarge"],
    captureMode: "realtime",
    speed: gpuSpeed,
  });
  return [
    gpu(PRIMARY_RECORDING_REGION),
    gpu("eu-north-1"),
    { id: "home", kind: "home", captureMode: "realtime", speed: 1 },
    {
      id: "cpu:eu-south-2",
      kind: "ec2",
      platform: "cpu",
      region: PRIMARY_RECORDING_REGION,
      instanceTypes: ["c7i.xlarge", "c7a.xlarge", "c7i-flex.xlarge", "m7i.xlarge"],
      captureMode: "realtime",
      speed: 1,
    },
  ];
}

/** th07（GPU 3倍速）・th08（GPU 2倍速）の計画を旧形へ差し替え、元へ戻す関数を返す。 */
export function useLegacyGpuFirstPlans(): () => void {
  const plans = RECORDING_PLANS as Partial<Record<GameId, readonly RecordingStep[]>>;
  const originals = { th07: plans.th07, th08: plans.th08 };
  plans.th07 = legacyGpuFirstPlan(3);
  plans.th08 = legacyGpuFirstPlan(2);
  return () => {
    plans.th07 = originals.th07;
    plans.th08 = originals.th08;
  };
}
