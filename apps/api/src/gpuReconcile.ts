import { vcpusForInstanceType } from "@sattori/shared";
import type { TaggedInstance } from "./ec2.js";
import type { GpuLease } from "./gpuSlots.js";
import type { ExecutionLiveness } from "./stepFunctions.js";

/**
 * GPU vCPU容量リース（Issue #270）のリコンサイラ判定ロジック。AWS APIを呼ばない
 * 純粋関数だけをここに置き、実際の走査・書き込みは
 * `handlers/sweepOrphanInstances.ts` が行う（`orphanInstances.ts`・`stalledJobs.ts`と
 * 同じ分離）。
 *
 * ## なぜ要るのか
 *
 * `shrinkGpuLease()`・`releaseGpuSlot()`の失敗は握りつぶす設計になっている
 * （録画そのものを失敗させないため）。握りつぶすだけで回収機構が無いと、
 * ADR 0046が守ろうとした「2台分の並列運用余地」が静かに失われ続ける。
 * このモジュールは、AWS上に実在するGPUインスタンス（`listTaggedInstances()`の
 * `instanceType`）を「事実」として、`GpuSlotsTable`の台帳をそれに合わせて
 * 補正する判定を提供する。
 */

/**
 * リース・補完リース作成の判定に使う猶予（ミリ秒）。`Launch` Lambdaの実行時間・
 * `DescribeInstances`の結果整合（起動直後のインスタンスが一時的に見えないことが
 * ある）を見込む。`ORPHAN_INSTANCE_GRACE_MINUTES`とは別の値——GPUリースは
 * インスタンス起動よりリース確保の方が先に起きる（`AcquireGpuSlot`→`Launch`の順）
 * ため、より短い猶予で十分。
 */
export const GPU_LEASE_RECONCILE_GRACE_MS = 10 * 60 * 1000;

export interface ObservedGpuUsage {
  /** jobIdごとの生存GPUインスタンス群から計算した実測vCPU（複数台なら合算、安全側）。 */
  vcpuByJobId: Map<string, number>;
  /** リースが存在しないのに生存しているGPUインスタンス。 */
  unleasedInstances: Array<{ jobId: string; instanceId: string; vcpu: number; launchTime: Date | null }>;
}

/**
 * タグ付きインスタンス一覧からGPU系（既知のインスタンスタイプ）だけを抽出し、
 * リース台帳と突き合わせるための実測値を作る。CPU系インスタンスは
 * `vcpusForInstanceType()`がnullを返すため自然に除外される。
 */
export function observeGpuUsage(
  instances: readonly TaggedInstance[],
  leases: readonly GpuLease[],
): ObservedGpuUsage {
  const leaseJobIds = new Set(leases.map((lease) => lease.jobId));
  const vcpuByJobId = new Map<string, number>();
  const unleasedInstances: ObservedGpuUsage["unleasedInstances"] = [];
  for (const instance of instances) {
    const vcpu = instance.instanceType ? vcpusForInstanceType(instance.instanceType) : null;
    if (vcpu === null) {
      continue;
    }
    vcpuByJobId.set(instance.jobId, (vcpuByJobId.get(instance.jobId) ?? 0) + vcpu);
    if (!leaseJobIds.has(instance.jobId)) {
      unleasedInstances.push({
        jobId: instance.jobId,
        instanceId: instance.instanceId,
        vcpu,
        launchTime: instance.launchTime,
      });
    }
  }
  return { vcpuByJobId, unleasedInstances };
}

export interface LeaseDriftCandidate {
  jobId: string;
  currentVcpu: number;
  observedVcpu: number;
}

/**
 * リースのvCPUと実測（生存インスタンスの実タイプ）が食い違っているものを補正対象
 * として選ぶ。`shrinkGpuLease()`が失敗した場合（縮小前の過大なvCPUのまま残る）を
 * 主に想定するが、増える方向（実測がリースより大きい）も理論上ありうるため両方を
 * 対象にする——安全側は常に「実測に合わせる」こと。
 */
export function selectDriftedLeases(
  leases: readonly GpuLease[],
  vcpuByJobId: ReadonlyMap<string, number>,
): LeaseDriftCandidate[] {
  const result: LeaseDriftCandidate[] = [];
  for (const lease of leases) {
    const observed = vcpuByJobId.get(lease.jobId);
    if (observed !== undefined && observed !== lease.vcpu) {
      result.push({ jobId: lease.jobId, currentVcpu: lease.vcpu, observedVcpu: observed });
    }
  }
  return result;
}

export interface IsReclaimableLeaseInput {
  lease: GpuLease;
  /** そのjobIdの生存GPUインスタンスが1台でもあるか。 */
  hasLiveInstance: boolean;
  executionLiveness: ExecutionLiveness;
  now: Date;
}

/**
 * 生存インスタンスが無く、Step Functions実行も生きていない（かつ猶予超過）リースを
 * 返却対象として選ぶ。判定の主たる根拠は`orphanInstances.ts`・`stalledJobs.ts`と
 * 同じく**実行の生死**——`hasLiveInstance`だけで判定すると、`Launch`が
 * `CreateFleet`を呼ぶ前（リース確保直後〜インスタンス起動までの一瞬）のリースを
 * 誤って回収してしまう。
 */
export function isReclaimableLease({
  lease,
  hasLiveInstance,
  executionLiveness,
  now,
}: IsReclaimableLeaseInput): boolean {
  if (hasLiveInstance) {
    return false;
  }
  if (executionLiveness === "running") {
    return false;
  }
  const acquiredAtMs = Date.parse(lease.acquiredAt);
  if (Number.isNaN(acquiredAtMs)) {
    return false;
  }
  return now.getTime() - acquiredAtMs >= GPU_LEASE_RECONCILE_GRACE_MS;
}

/**
 * リースが存在しないのに生存しているGPUインスタンスに対し、補完リースを作成すべきか。
 * 起動直後（`AcquireGpuSlot`がリースを確保してから`shrinkGpuLease`が実タイプを
 * 記録するまでの間に一瞬インスタンスだけ見える窓、または`launchTime`が
 * `DescribeInstances`にまだ反映されていない場合）を誤検知しないよう猶予を設ける。
 * `launchTime`が不明な場合は「たった今起動した」扱いで対象外にする（安全側）。
 */
export function isUnleasedInstanceNeedingLease(launchTime: Date | null, now: Date): boolean {
  if (launchTime === null) {
    return false;
  }
  return now.getTime() - launchTime.getTime() >= GPU_LEASE_RECONCILE_GRACE_MS;
}
