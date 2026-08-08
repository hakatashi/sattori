import { describe, expect, it } from "vitest";
import type { WorkerHeartbeat } from "@sattori/shared";
import { WORKER_HEARTBEAT_FRESH_SECONDS } from "@sattori/shared";
import {
  DEFAULT_ROUTING_POLICY,
  isWorkerEligible,
  routingPolicyFor,
  selectHomeWorker,
} from "./workerRouting.js";
import type { GameRoutingPolicy } from "./workerRouting.js";

const NOW = new Date("2026-08-09T12:00:00.000Z");
const JOB = { game: "th07" } as const;

function heartbeat(overrides: Partial<WorkerHeartbeat> = {}): WorkerHeartbeat {
  return {
    workerId: "home-1",
    kind: "home",
    lastHeartbeatAt: NOW.toISOString(),
    accepting: true,
    activeJobs: 0,
    maxConcurrency: 4,
    supportedGames: ["th06", "th07", "th08", "th11"],
    capabilities: [],
    ttl: Math.floor(NOW.getTime() / 1000) + 900,
    ...overrides,
  };
}

describe("routingPolicyFor", () => {
  it("タイトル固有の指定が無ければ既定の方針を返す", () => {
    expect(routingPolicyFor("th07")).toEqual(DEFAULT_ROUTING_POLICY);
  });

  it("オファー待機は自宅デーモンのポーリング間隔より十分長い", () => {
    expect(DEFAULT_ROUTING_POLICY.offerWindowSeconds).toBeGreaterThanOrEqual(10);
  });
});

describe("isWorkerEligible", () => {
  const policy = DEFAULT_ROUTING_POLICY;

  it("空きがあり対応タイトルなら引き受けられる", () => {
    expect(isWorkerEligible(heartbeat(), JOB, policy, NOW)).toBe(true);
  });

  it("ハートビートが古ければ引き受けない", () => {
    const stale = new Date(NOW.getTime() - (WORKER_HEARTBEAT_FRESH_SECONDS + 10) * 1000);
    expect(
      isWorkerEligible(heartbeat({ lastHeartbeatAt: stale.toISOString() }), JOB, policy, NOW),
    ).toBe(false);
  });

  it("受付停止中(ドレイン中など)なら引き受けない", () => {
    expect(isWorkerEligible(heartbeat({ accepting: false }), JOB, policy, NOW)).toBe(false);
  });

  it("同時実行の上限に達していれば引き受けない", () => {
    expect(
      isWorkerEligible(heartbeat({ activeJobs: 4, maxConcurrency: 4 }), JOB, policy, NOW),
    ).toBe(false);
  });

  it("対応していないタイトルは引き受けない", () => {
    expect(isWorkerEligible(heartbeat({ supportedGames: ["th06"] }), JOB, policy, NOW)).toBe(false);
  });

  it("要求された能力を宣言していなければ引き受けない(th20の低速録画を見据えた分岐)", () => {
    const strict: GameRoutingPolicy = {
      ...policy,
      requiredCapabilities: ["slow-motion-recording"],
    };
    expect(isWorkerEligible(heartbeat(), JOB, strict, NOW)).toBe(false);
    expect(
      isWorkerEligible(heartbeat({ capabilities: ["slow-motion-recording"] }), JOB, strict, NOW),
    ).toBe(true);
  });
});

describe("selectHomeWorker", () => {
  it("方針がオファーしない場合は常にnull", () => {
    const policy = { ...DEFAULT_ROUTING_POLICY, offerToHomeWorker: false };
    expect(selectHomeWorker([heartbeat()], JOB, policy, NOW)).toBeNull();
  });

  it("引き受けられるワーカーが1台も無ければnull(=即EC2)", () => {
    expect(
      selectHomeWorker([heartbeat({ accepting: false })], JOB, DEFAULT_ROUTING_POLICY, NOW),
    ).toBeNull();
  });

  it("空きスロットが最も多いワーカーを選ぶ", () => {
    const busy = heartbeat({ workerId: "home-1", activeJobs: 3 });
    const idle = heartbeat({ workerId: "home-2", activeJobs: 1 });
    expect(selectHomeWorker([busy, idle], JOB, DEFAULT_ROUTING_POLICY, NOW)?.workerId).toBe(
      "home-2",
    );
  });

  it("空きが同数ならworkerIdで安定して選ぶ", () => {
    const a = heartbeat({ workerId: "home-b" });
    const b = heartbeat({ workerId: "home-a" });
    expect(selectHomeWorker([a, b], JOB, DEFAULT_ROUTING_POLICY, NOW)?.workerId).toBe("home-a");
  });
});
