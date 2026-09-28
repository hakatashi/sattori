import { describe, expect, it } from "vitest";
import {
  estimateQueueWaitSeconds,
  GPU_INSTANCE_TYPE_VCPUS,
  GPU_JOB_OVERHEAD_SECONDS,
  GPU_MAX_INSTANCE_VCPU,
  GPU_MIN_INSTANCE_VCPU,
  GPU_QUEUE_FALLBACK_DURATION_SECONDS,
  GPU_QUEUE_MAX_WAIT_MINUTES,
  GPU_QUEUE_POLL_MAX_SECONDS,
  GPU_QUEUE_STALE_AFTER_SECONDS,
  GPU_VCPU_QUOTA,
  isHeartbeatStale,
  isQueueWaitTimedOut,
  nextPollIntervalSeconds,
  reservableVcpu,
  vcpusForInstanceType,
} from "./gpuQueue.js";

describe("GPU_INSTANCE_TYPE_VCPUS", () => {
  it("最小・最大のvCPU数が実際の候補と一致する", () => {
    expect(GPU_MIN_INSTANCE_VCPU).toBe(4);
    expect(GPU_MAX_INSTANCE_VCPU).toBe(8);
  });

  it("クオータで最大候補タイプ(g6f.2xlarge)が少なくとも1台起動できる", () => {
    // 下回るとリトライ時(attempt>1)のminVcpu=GPU_MAX_INSTANCE_VCPU要求が永久に満たせない。
    expect(GPU_VCPU_QUOTA).toBeGreaterThanOrEqual(GPU_MAX_INSTANCE_VCPU);
  });

  it("クオータが全候補タイプのvCPU数で割り切れる(使えない端数が残らない)", () => {
    for (const vcpu of Object.values(GPU_INSTANCE_TYPE_VCPUS)) {
      expect(GPU_VCPU_QUOTA % vcpu).toBe(0);
    }
  });
});

describe("vcpusForInstanceType", () => {
  it("候補タイプのvCPU数を返す", () => {
    expect(vcpusForInstanceType("g6f.xlarge")).toBe(4);
    expect(vcpusForInstanceType("g6f.2xlarge")).toBe(8);
  });

  it("候補外のタイプはnull", () => {
    expect(vcpusForInstanceType("c7i.xlarge")).toBeNull();
  });
});

describe("reservableVcpu", () => {
  it("8vCPU分の空きがあれば最大値を返す", () => {
    expect(reservableVcpu(8)).toBe(8);
    expect(reservableVcpu(10)).toBe(8);
  });

  it("4vCPU分しか空きが無ければ最小値を返す", () => {
    expect(reservableVcpu(4)).toBe(4);
    expect(reservableVcpu(7)).toBe(4);
  });

  it("最小要求量未満の空きはnull(確保不可)", () => {
    expect(reservableVcpu(3)).toBeNull();
    expect(reservableVcpu(0)).toBeNull();
  });

  it("minVcpuを指定した場合はその値未満ならnull(リトライ時に8vCPUを要求する用途)", () => {
    expect(reservableVcpu(4, 8)).toBeNull();
    expect(reservableVcpu(7, 8)).toBeNull();
    expect(reservableVcpu(8, 8)).toBe(8);
  });
});

describe("nextPollIntervalSeconds", () => {
  it("待機直後は短い間隔", () => {
    expect(nextPollIntervalSeconds(0)).toBe(15);
    expect(nextPollIntervalSeconds(119)).toBe(15);
  });

  it("2分経過後は中間の間隔", () => {
    expect(nextPollIntervalSeconds(120)).toBe(30);
    expect(nextPollIntervalSeconds(599)).toBe(30);
  });

  it("10分経過後は最大間隔に張り付く", () => {
    expect(nextPollIntervalSeconds(600)).toBe(120);
    expect(nextPollIntervalSeconds(7200)).toBe(120);
  });

  it("最大待機時間をフルに待ってもStep Functionsの履歴イベント上限(25,000件)に収まる", () => {
    // 1周(Wait→Choice→Task)あたり約9イベント。MAX_ATTEMPTS=10のすべてのリトライが
    // 毎回フル待機したと仮定しても十分な余裕があることを確認する
    // (docs/decisions/0056-gpu-vcpu-lease-and-queue.md参照)。
    const EVENTS_PER_POLL_CYCLE = 9;
    const MAX_ATTEMPTS = 10;

    let elapsed = 0;
    let cycles = 0;
    while (elapsed < GPU_QUEUE_MAX_WAIT_MINUTES * 60) {
      elapsed += nextPollIntervalSeconds(elapsed);
      cycles += 1;
    }

    const eventsPerFullWait = cycles * EVENTS_PER_POLL_CYCLE;
    expect(eventsPerFullWait * MAX_ATTEMPTS).toBeLessThan(25_000);
  });
});

describe("isQueueWaitTimedOut", () => {
  it("上限未満はfalse", () => {
    expect(isQueueWaitTimedOut(GPU_QUEUE_MAX_WAIT_MINUTES * 60 - 1)).toBe(false);
  });

  it("上限以上はtrue", () => {
    expect(isQueueWaitTimedOut(GPU_QUEUE_MAX_WAIT_MINUTES * 60)).toBe(true);
  });
});

describe("isHeartbeatStale", () => {
  it("しきい値以下はfalse", () => {
    expect(isHeartbeatStale(GPU_QUEUE_STALE_AFTER_SECONDS)).toBe(false);
  });

  it("しきい値超過はtrue", () => {
    expect(isHeartbeatStale(GPU_QUEUE_STALE_AFTER_SECONDS + 1)).toBe(true);
  });

  it("しきい値はポーリング間隔上限の4倍(死んだ待機者を数周の猶予で検知する)", () => {
    expect(GPU_QUEUE_STALE_AFTER_SECONDS).toBe(GPU_QUEUE_POLL_MAX_SECONDS * 4);
  });
});

describe("estimateQueueWaitSeconds", () => {
  const now = Date.parse("2026-09-19T00:00:00Z");

  it("前方ジョブなし・実行中リースなしなら0", () => {
    expect(estimateQueueWaitSeconds([], [], now)).toBe(0);
  });

  it("前方ジョブの所要時間合計にオーバーヘッドを加算する", () => {
    const result = estimateQueueWaitSeconds(
      [{ estimatedDurationSeconds: 600 }, { estimatedDurationSeconds: 300 }],
      [],
      now,
    );
    expect(result).toBe(600 + GPU_JOB_OVERHEAD_SECONDS + 300 + GPU_JOB_OVERHEAD_SECONDS);
  });

  it("estimatedDurationSecondsがnullならフォールバック値を使う", () => {
    const result = estimateQueueWaitSeconds([{ estimatedDurationSeconds: null }], [], now);
    expect(result).toBe(GPU_QUEUE_FALLBACK_DURATION_SECONDS + GPU_JOB_OVERHEAD_SECONDS);
  });

  it("実行中リースの中で最も早く空く時刻までの残り時間を加算する(並列1で保守的に見積もる)", () => {
    const result = estimateQueueWaitSeconds(
      [],
      [{ expectedFinishAtMs: now + 300_000 }, { expectedFinishAtMs: now + 900_000 }],
      now,
    );
    expect(result).toBe(300);
  });

  it("空く時刻が過去でも負にならない", () => {
    const result = estimateQueueWaitSeconds([], [{ expectedFinishAtMs: now - 60_000 }], now);
    expect(result).toBe(0);
  });

  it("実行中リースと前方ジョブの両方がある場合は合算する", () => {
    const result = estimateQueueWaitSeconds(
      [{ estimatedDurationSeconds: 600 }],
      [{ expectedFinishAtMs: now + 120_000 }],
      now,
    );
    expect(result).toBe(120 + 600 + GPU_JOB_OVERHEAD_SECONDS);
  });
});
