import { describe, expect, it } from "vitest";
import type { TaggedInstance } from "./ec2.js";
import {
  GPU_LEASE_RECONCILE_GRACE_MS,
  isReclaimableLease,
  isUnleasedInstanceNeedingLease,
  observeGpuUsage,
  selectDriftedLeases,
} from "./gpuReconcile.js";
import type { GpuLease } from "./gpuSlots.js";

const NOW = new Date("2026-09-19T00:00:00.000Z");

function lease(overrides: Partial<GpuLease> = {}): GpuLease {
  return {
    jobId: "job-1",
    vcpu: 8,
    acquiredAt: new Date(NOW.getTime() - 20 * 60 * 1000).toISOString(),
    expiresAt: new Date(NOW.getTime() + 160 * 60 * 1000).toISOString(),
    expectedFinishAt: new Date(NOW.getTime() + 10 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

function taggedInstance(overrides: Partial<TaggedInstance> = {}): TaggedInstance {
  return {
    instanceId: "i-1",
    jobId: "job-1",
    launchTime: new Date(NOW.getTime() - 20 * 60 * 1000),
    instanceType: "g6f.xlarge",
    ...overrides,
  };
}

describe("observeGpuUsage", () => {
  it("GPU系インスタンスのvCPUをjobId単位で合算する", () => {
    const { vcpuByJobId } = observeGpuUsage(
      [taggedInstance({ jobId: "job-1", instanceType: "g6f.xlarge" })],
      [],
    );
    expect(vcpuByJobId.get("job-1")).toBe(4);
  });

  it("CPU系インスタンス(instanceTypeが候補外)は無視する", () => {
    const { vcpuByJobId } = observeGpuUsage(
      [taggedInstance({ jobId: "job-1", instanceType: "c7i.xlarge" })],
      [],
    );
    expect(vcpuByJobId.has("job-1")).toBe(false);
  });

  it("instanceTypeがnull(DescribeInstancesが返さなかった)は無視する", () => {
    const { vcpuByJobId } = observeGpuUsage(
      [taggedInstance({ jobId: "job-1", instanceType: null })],
      [],
    );
    expect(vcpuByJobId.has("job-1")).toBe(false);
  });

  it("同一ジョブに複数台あれば合算する(安全側)", () => {
    const { vcpuByJobId } = observeGpuUsage(
      [
        taggedInstance({ instanceId: "i-1", jobId: "job-1", instanceType: "g6f.xlarge" }),
        taggedInstance({ instanceId: "i-2", jobId: "job-1", instanceType: "g6f.xlarge" }),
      ],
      [],
    );
    expect(vcpuByJobId.get("job-1")).toBe(8);
  });

  it("リースが無いGPUインスタンスをunleasedInstancesへ挙げる", () => {
    const { unleasedInstances } = observeGpuUsage(
      [taggedInstance({ jobId: "job-1", instanceType: "g6f.xlarge" })],
      [],
    );
    expect(unleasedInstances).toEqual([
      { jobId: "job-1", instanceId: "i-1", vcpu: 4, launchTime: taggedInstance().launchTime },
    ]);
  });

  it("リースが既にあるGPUインスタンスはunleasedInstancesに挙げない", () => {
    const { unleasedInstances } = observeGpuUsage(
      [taggedInstance({ jobId: "job-1", instanceType: "g6f.xlarge" })],
      [lease({ jobId: "job-1" })],
    );
    expect(unleasedInstances).toEqual([]);
  });
});

describe("selectDriftedLeases", () => {
  it("実測とリースのvCPUが食い違うものを選ぶ", () => {
    const drifted = selectDriftedLeases(
      [lease({ jobId: "job-1", vcpu: 8 })],
      new Map([["job-1", 4]]),
    );
    expect(drifted).toEqual([{ jobId: "job-1", currentVcpu: 8, observedVcpu: 4 }]);
  });

  it("一致していれば選ばない", () => {
    const drifted = selectDriftedLeases(
      [lease({ jobId: "job-1", vcpu: 4 })],
      new Map([["job-1", 4]]),
    );
    expect(drifted).toEqual([]);
  });

  it("実測が無い(生存インスタンスが無い)ジョブは対象外(回収ループの担当)", () => {
    const drifted = selectDriftedLeases([lease({ jobId: "job-1", vcpu: 8 })], new Map());
    expect(drifted).toEqual([]);
  });
});

describe("isReclaimableLease", () => {
  const oldEnoughLease = lease({
    acquiredAt: new Date(NOW.getTime() - GPU_LEASE_RECONCILE_GRACE_MS - 1000).toISOString(),
  });

  it("生存インスタンスがあれば対象外", () => {
    expect(
      isReclaimableLease({
        lease: oldEnoughLease,
        hasLiveInstance: true,
        executionLiveness: "finished",
        now: NOW,
      }),
    ).toBe(false);
  });

  it("実行が生きていれば対象外(起動直前の可能性があるため)", () => {
    expect(
      isReclaimableLease({
        lease: oldEnoughLease,
        hasLiveInstance: false,
        executionLiveness: "running",
        now: NOW,
      }),
    ).toBe(false);
  });

  it("猶予未満は対象外", () => {
    const freshLease = lease({ acquiredAt: new Date(NOW.getTime() - 1000).toISOString() });
    expect(
      isReclaimableLease({
        lease: freshLease,
        hasLiveInstance: false,
        executionLiveness: "finished",
        now: NOW,
      }),
    ).toBe(false);
  });

  it("生存インスタンスなし・実行終了・猶予超過なら回収対象", () => {
    expect(
      isReclaimableLease({
        lease: oldEnoughLease,
        hasLiveInstance: false,
        executionLiveness: "finished",
        now: NOW,
      }),
    ).toBe(true);
  });

  it("実行が存在しない(absent)場合も回収対象", () => {
    expect(
      isReclaimableLease({
        lease: oldEnoughLease,
        hasLiveInstance: false,
        executionLiveness: "absent",
        now: NOW,
      }),
    ).toBe(true);
  });

  it("acquiredAtが不正な値なら対象外(安全側)", () => {
    expect(
      isReclaimableLease({
        lease: lease({ acquiredAt: "invalid" }),
        hasLiveInstance: false,
        executionLiveness: "finished",
        now: NOW,
      }),
    ).toBe(false);
  });
});

describe("isUnleasedInstanceNeedingLease", () => {
  it("launchTimeが不明なら対象外(たった今起動した扱い)", () => {
    expect(isUnleasedInstanceNeedingLease(null, NOW)).toBe(false);
  });

  it("猶予未満は対象外", () => {
    const recent = new Date(NOW.getTime() - 1000);
    expect(isUnleasedInstanceNeedingLease(recent, NOW)).toBe(false);
  });

  it("猶予超過なら補完リースが必要", () => {
    const old = new Date(NOW.getTime() - GPU_LEASE_RECONCILE_GRACE_MS - 1000);
    expect(isUnleasedInstanceNeedingLease(old, NOW)).toBe(true);
  });
});
