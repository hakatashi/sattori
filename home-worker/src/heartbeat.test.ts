/** ハートビート（heartbeat）のテスト。 */
import { WORKER_HEARTBEAT_TTL_SECONDS } from "@sattori/shared";
import { describe, expect, it } from "vitest";
import { buildHeartbeat } from "./heartbeat.js";
import { makeConfig } from "./testing.js";

describe("buildHeartbeat", () => {
  it("ハートビートはAWS側の判定に必要な項目を揃える", () => {
    const now = new Date("2026-08-09T12:00:00.000Z");

    const item = buildHeartbeat(makeConfig({ capabilities: ["slow-motion-recording"] }), {
      accepting: true,
      activeJobs: 1,
      now,
    });

    expect(item).toEqual({
      workerId: "home-1",
      kind: "home",
      lastHeartbeatAt: now.toISOString(),
      accepting: true,
      activeJobs: 1,
      maxConcurrency: 2,
      supportedGames: ["th06", "th07"],
      capabilities: ["slow-motion-recording"],
      ttl: Math.floor(now.getTime() / 1000) + WORKER_HEARTBEAT_TTL_SECONDS,
    });
  });
});
