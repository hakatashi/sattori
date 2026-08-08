import { describe, expect, it } from "vitest";
import {
  isHeartbeatFresh,
  WORKER_HEARTBEAT_FRESH_SECONDS,
  WORKER_HEARTBEAT_INTERVAL_SECONDS,
  type WorkerHeartbeat,
} from "./worker.js";

const NOW = new Date("2026-08-09T12:00:00.000Z");

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

describe("isHeartbeatFresh", () => {
  it("鮮度上限ちょうどまでは新鮮とみなす", () => {
    const lastSeen = new Date(NOW.getTime() - WORKER_HEARTBEAT_FRESH_SECONDS * 1000);
    expect(isHeartbeatFresh(heartbeat({ lastHeartbeatAt: lastSeen.toISOString() }), NOW)).toBe(true);
  });

  it("鮮度上限を過ぎたハートビートは古いとみなす", () => {
    const lastSeen = new Date(NOW.getTime() - (WORKER_HEARTBEAT_FRESH_SECONDS + 1) * 1000);
    expect(isHeartbeatFresh(heartbeat({ lastHeartbeatAt: lastSeen.toISOString() }), NOW)).toBe(
      false,
    );
  });

  it("時計が大きく進んだハートビートも古い扱いにする(オファーの吸い込み防止)", () => {
    const lastSeen = new Date(NOW.getTime() + (WORKER_HEARTBEAT_FRESH_SECONDS + 1) * 1000);
    expect(isHeartbeatFresh(heartbeat({ lastHeartbeatAt: lastSeen.toISOString() }), NOW)).toBe(
      false,
    );
  });

  it("パースできない時刻は新鮮とみなさない", () => {
    expect(isHeartbeatFresh(heartbeat({ lastHeartbeatAt: "not-a-date" }), NOW)).toBe(false);
  });

  it("ハートビート間隔は鮮度上限より十分短い", () => {
    expect(WORKER_HEARTBEAT_INTERVAL_SECONDS).toBeLessThan(WORKER_HEARTBEAT_FRESH_SECONDS);
  });
});
