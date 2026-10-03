import { describe, expect, it } from "vitest";
import {
  estimateQueueWaitSeconds,
  GPU_INSTANCE_TYPE_VCPUS,
  GPU_JOB_OVERHEAD_SECONDS,
  GPU_INSTANCE_VCPU,
  estimateGpuOccupancySeconds,
  GPU_QUEUE_ESTIMATE_PARALLELISM,
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
  it("1ジョブの確保量は起動候補(g6f.2xlarge)のvCPU数と一致する(Issue #288)", () => {
    expect(GPU_INSTANCE_VCPU).toBe(GPU_INSTANCE_TYPE_VCPUS["g6f.2xlarge"]);
  });

  it("クオータでg6f.2xlargeが少なくとも1台起動できる", () => {
    expect(GPU_VCPU_QUOTA).toBeGreaterThanOrEqual(GPU_INSTANCE_VCPU);
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
  it("8vCPU分の空きがあれば8を返す", () => {
    expect(reservableVcpu(8)).toBe(8);
    expect(reservableVcpu(10)).toBe(8);
  });

  it("8vCPU未満の空きはnull(g6f.xlargeでの投機的確保はしない、Issue #288)", () => {
    expect(reservableVcpu(7)).toBeNull();
    expect(reservableVcpu(4)).toBeNull();
    expect(reservableVcpu(0)).toBeNull();
  });
});

describe("estimateGpuOccupancySeconds", () => {
  it("等倍は尺+オーバーヘッド", () => {
    expect(estimateGpuOccupancySeconds(1200)).toBe(1200 + GPU_JOB_OVERHEAD_SECONDS);
  });

  it("倍速録画は録画部分が速度で割り引かれる", () => {
    expect(estimateGpuOccupancySeconds(1200, 2)).toBeCloseTo((1200 * 1.05) / 2 + GPU_JOB_OVERHEAD_SECONDS);
    expect(estimateGpuOccupancySeconds(1200, 4)).toBeLessThan(estimateGpuOccupancySeconds(1200, 2));
  });

  it("尺が不明ならフォールバック値を使う", () => {
    expect(estimateGpuOccupancySeconds(null)).toBe(
      GPU_QUEUE_FALLBACK_DURATION_SECONDS + GPU_JOB_OVERHEAD_SECONDS,
    );
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

describe("GPU_QUEUE_ESTIMATE_PARALLELISM", () => {
  it("クオータを1ジョブの確保量で割った並列数(最低1)", () => {
    expect(GPU_QUEUE_ESTIMATE_PARALLELISM).toBe(
      Math.max(1, Math.floor(GPU_VCPU_QUOTA / GPU_INSTANCE_VCPU)),
    );
  });
});

describe("estimateQueueWaitSeconds（並列1: 直列の見積もり）", () => {
  const now = Date.parse("2026-09-19T00:00:00Z");

  it("前方ジョブなし・実行中リースなしなら0", () => {
    expect(estimateQueueWaitSeconds([], [], now, 1)).toBe(0);
  });

  it("前方ジョブの所要時間合計にオーバーヘッドを加算する", () => {
    const result = estimateQueueWaitSeconds(
      [{ estimatedDurationSeconds: 600 }, { estimatedDurationSeconds: 300 }],
      [],
      now,
      1,
    );
    expect(result).toBe(600 + GPU_JOB_OVERHEAD_SECONDS + 300 + GPU_JOB_OVERHEAD_SECONDS);
  });

  it("estimatedDurationSecondsがnullならフォールバック値を使う", () => {
    const result = estimateQueueWaitSeconds([{ estimatedDurationSeconds: null }], [], now, 1);
    expect(result).toBe(GPU_QUEUE_FALLBACK_DURATION_SECONDS + GPU_JOB_OVERHEAD_SECONDS);
  });

  it("実行中リースの中で最も早く空く時刻までの残り時間を加算する", () => {
    const result = estimateQueueWaitSeconds(
      [],
      [{ expectedFinishAtMs: now + 300_000 }, { expectedFinishAtMs: now + 900_000 }],
      now,
      1,
    );
    expect(result).toBe(300);
  });

  it("空く時刻が過去でも負にならない", () => {
    const result = estimateQueueWaitSeconds([], [{ expectedFinishAtMs: now - 60_000 }], now, 1);
    expect(result).toBe(0);
  });

  it("実行中リースと前方ジョブの両方がある場合は合算する", () => {
    const result = estimateQueueWaitSeconds(
      [{ estimatedDurationSeconds: 600 }],
      [{ expectedFinishAtMs: now + 120_000 }],
      now,
      1,
    );
    expect(result).toBe(120 + 600 + GPU_JOB_OVERHEAD_SECONDS);
  });
});

describe("estimateQueueWaitSeconds（並列P: リストスケジューリング）", () => {
  const now = Date.parse("2026-09-19T00:00:00Z");
  // オーバーヘッド込みでちょうど20分になる録画時間。
  const twentyMinJob = { estimatedDurationSeconds: 20 * 60 - GPU_JOB_OVERHEAD_SECONDS };
  const leasesFinishingIn = (...minutes: number[]) =>
    minutes.map((m) => ({ expectedFinishAtMs: now + m * 60_000 }));

  it("前方3本・実行中4本(残り5/10/15/20分)・並列4なら、4本目の枠が空く20分後", () => {
    // 直列(並列1)だと 5 + 20×3 = 65分になる。
    const result = estimateQueueWaitSeconds(
      [twentyMinJob, twentyMinJob, twentyMinJob],
      leasesFinishingIn(20, 5, 15, 10),
      now,
      4,
    );
    expect(result).toBe(20 * 60);
  });

  it("前方ジョブが枠数を超えると、前方ジョブの終了を待つ", () => {
    // 枠: [5,10,15,20] → 前方4本で [25,30,35,40] → 5本目は25分後に空いた枠に載り [30,35,40,45]
    const result = estimateQueueWaitSeconds(
      Array.from({ length: 5 }, () => twentyMinJob),
      leasesFinishingIn(5, 10, 15, 20),
      now,
      4,
    );
    expect(result).toBe(30 * 60);
  });

  it("先頭(前方ジョブなし)は並列数によらず最も早く空くリースの残り時間", () => {
    const leases = leasesFinishingIn(7, 3, 12, 9, 30);
    expect(estimateQueueWaitSeconds([], leases, now, 4)).toBe(
      estimateQueueWaitSeconds([], leases, now, 1),
    );
    expect(estimateQueueWaitSeconds([], leases, now, 4)).toBe(3 * 60);
  });

  it("リースが枠数に満たなければ残りの枠は即空きとして扱う", () => {
    const result = estimateQueueWaitSeconds(
      [twentyMinJob],
      leasesFinishingIn(10, 10),
      now,
      4,
    );
    expect(result).toBe(0);
  });

  it("リースが枠数を超える場合は早く空く順にP本だけを使う", () => {
    // 並列2: 枠 [5,10]（25分・40分のリースは無視）→ 前方2本で [25,30] → 25分後
    const result = estimateQueueWaitSeconds(
      [twentyMinJob, twentyMinJob],
      leasesFinishingIn(40, 5, 25, 10),
      now,
      2,
    );
    expect(result).toBe(25 * 60);
  });

  it("並列数を省略するとGPU_QUEUE_ESTIMATE_PARALLELISMを使う", () => {
    const ahead = [twentyMinJob, twentyMinJob, twentyMinJob];
    const leases = leasesFinishingIn(5, 10, 15, 20);
    expect(estimateQueueWaitSeconds(ahead, leases, now)).toBe(
      estimateQueueWaitSeconds(ahead, leases, now, GPU_QUEUE_ESTIMATE_PARALLELISM),
    );
  });
});

describe("estimateQueueWaitSeconds（録画速度、Issue #288）", () => {
  it("先行ジョブが倍速録画なら待ち時間が短くなる", () => {
    const now = Date.parse("2026-10-01T00:00:00.000Z");
    const native = estimateQueueWaitSeconds([{ estimatedDurationSeconds: 1200 }], [], now, 1);
    const speedup = estimateQueueWaitSeconds(
      [{ estimatedDurationSeconds: 1200, recordingSpeed: 2 }],
      [],
      now,
      1,
    );
    expect(speedup).toBeLessThan(native);
    expect(speedup).toBe(Math.round(estimateGpuOccupancySeconds(1200, 2) * 1e6) / 1e6);
  });
});
