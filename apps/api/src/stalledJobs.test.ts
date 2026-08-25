import { describe, expect, it } from "vitest";
import { isStalledJob, STALLED_JOB_THRESHOLD_MS } from "./stalledJobs.js";

const NOW = new Date("2026-08-26T12:00:00.000Z");

/** `NOW` から `minutes` 分前の更新時刻。 */
function updatedAgo(minutes: number): string {
  return new Date(NOW.getTime() - minutes * 60 * 1000).toISOString();
}

describe("isStalledJob", () => {
  it("実行が終わっていて猶予を過ぎた非終端ジョブは固まったと判定する", () => {
    expect(
      isStalledJob({
        status: "recording",
        updatedAt: updatedAgo(200),
        executionLiveness: "finished",
        now: NOW,
      }),
    ).toBe(true);
  });

  it("実行が存在しない(absent)場合も同様", () => {
    expect(
      isStalledJob({
        status: "queued",
        updatedAt: updatedAgo(200),
        executionLiveness: "absent",
        now: NOW,
      }),
    ).toBe(true);
  });

  it("実行が生きている(running)なら、updatedAtがどれだけ古くても対象外", () => {
    expect(
      isStalledJob({
        status: "recording",
        updatedAt: updatedAgo(10000),
        executionLiveness: "running",
        now: NOW,
      }),
    ).toBe(false);
  });

  it("猶予内の新しいジョブは対象外", () => {
    expect(
      isStalledJob({
        status: "launching",
        updatedAt: updatedAgo(10),
        executionLiveness: "finished",
        now: NOW,
      }),
    ).toBe(false);
  });

  it("ちょうど猶予に達した時点で対象になる(境界値)", () => {
    const updatedAt = new Date(NOW.getTime() - STALLED_JOB_THRESHOLD_MS).toISOString();
    expect(
      isStalledJob({ status: "converting", updatedAt, executionLiveness: "finished", now: NOW }),
    ).toBe(true);
  });

  it("既に終端状態(done/failed)は対象外", () => {
    for (const status of ["done", "failed"] as const) {
      expect(
        isStalledJob({ status, updatedAt: updatedAgo(200), executionLiveness: "finished", now: NOW }),
      ).toBe(false);
    }
  });

  it("pendingは実行がまだ無いのが正常なので対象外", () => {
    expect(
      isStalledJob({
        status: "pending",
        updatedAt: updatedAgo(2000),
        executionLiveness: "absent",
        now: NOW,
      }),
    ).toBe(false);
  });

  it("updatedAtが不正な値なら安全側(対象外)に倒す", () => {
    expect(
      isStalledJob({
        status: "recording",
        updatedAt: "not-a-date",
        executionLiveness: "finished",
        now: NOW,
      }),
    ).toBe(false);
  });
});
