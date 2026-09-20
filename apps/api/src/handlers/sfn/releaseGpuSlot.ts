import { loadConfig } from "../../config.js";
import { releaseGpuSlot } from "../../gpuSlots.js";

/**
 * Step Functions の `ReleaseGpuSlot` ステート（`Launch`成功後、`Succeed`の手前）から
 * 呼ばれるLambda（Issue #270）。GPU vCPU容量リースを返却し、確保していた枠を
 * 他のジョブへ回す。
 *
 * `releaseGpuSlot()`（`gpuSlots.ts`）はリースが存在しなくても冪等に成功するため、
 * 非GPUジョブから呼んでも安全——`GetItem`が1回増えるだけで実害が無い（GPUジョブか
 * どうかをここで判定する必要が無く、呼び出し元のステートマシン定義を単純に保てる）。
 *
 * **失敗してもジョブを失敗にしてはならない**（録画自体は既に成功している）。
 * CDK側で `addRetry` + 失敗しても `Succeed` へ倒す `addCatch` を設定しており、
 * 取りこぼしたリースはリコンサイラ（`handlers/sweepOrphanInstances.ts`）が
 * 期限切れ回収・実在インスタンスとの突き合わせで最終的に回収する。
 */
export interface ReleaseGpuSlotEvent {
  jobId: string;
}

export const handler = async (event: ReleaseGpuSlotEvent): Promise<void> => {
  const config = loadConfig();
  await releaseGpuSlot(config.gpuSlotsTable, event.jobId);
  console.log(JSON.stringify({ event: "gpu_slot_released", jobId: event.jobId }));
};
