import { describe, expect, it } from "vitest";
import { GPU_QUEUE_STALE_AFTER_SECONDS } from "@sattori/shared";
import {
  entriesAhead,
  excludeStaleEntries,
  isQueueHead,
  queuePosition,
} from "./gpuQueue.js";
import type { QueueEntry } from "./gpuQueue.js";

const NOW = new Date("2026-09-19T00:00:00.000Z");

function entry(jobId: string, queuedAtOffsetSec: number, heartbeatAgeSec = 0): QueueEntry {
  return {
    jobId,
    gpuQueuedAt: new Date(NOW.getTime() + queuedAtOffsetSec * 1000).toISOString(),
    gpuQueueHeartbeatAt: new Date(NOW.getTime() - heartbeatAgeSec * 1000).toISOString(),
  };
}

describe("excludeStaleEntries", () => {
  it("心拍が新しいエントリは残す", () => {
    const entries = [entry("job-1", 0, 10)];
    expect(excludeStaleEntries(entries, NOW)).toEqual(entries);
  });

  it("心拍がしきい値を超えて古いエントリは除外する", () => {
    const entries = [entry("job-1", 0, GPU_QUEUE_STALE_AFTER_SECONDS + 1)];
    expect(excludeStaleEntries(entries, NOW)).toEqual([]);
  });

  it("しきい値ちょうどは残す", () => {
    const entries = [entry("job-1", 0, GPU_QUEUE_STALE_AFTER_SECONDS)];
    expect(excludeStaleEntries(entries, NOW)).toEqual(entries);
  });

  it("心拍が不正な値のエントリは除外する(安全側)", () => {
    const entries: QueueEntry[] = [
      { jobId: "job-1", gpuQueuedAt: NOW.toISOString(), gpuQueueHeartbeatAt: "invalid" },
    ];
    expect(excludeStaleEntries(entries, NOW)).toEqual([]);
  });
});

describe("entriesAhead / isQueueHead / queuePosition", () => {
  it("待機列が自分のみなら先頭で順位1", () => {
    const entries = [entry("job-1", 0)];
    expect(isQueueHead("job-1", entries)).toBe(true);
    expect(queuePosition("job-1", entries)).toBe(1);
    expect(entriesAhead("job-1", entries)).toEqual([]);
  });

  it("自分より古いgpuQueuedAtが居れば先頭でない", () => {
    const entries = [entry("job-1", -10), entry("job-2", 0)];
    expect(isQueueHead("job-2", entries)).toBe(false);
    expect(queuePosition("job-2", entries)).toBe(2);
    expect(entriesAhead("job-2", entries).map((e) => e.jobId)).toEqual(["job-1"]);
  });

  it("自分より新しいgpuQueuedAtは順位に数えない", () => {
    const entries = [entry("job-1", 0), entry("job-2", 10)];
    expect(isQueueHead("job-1", entries)).toBe(true);
    expect(queuePosition("job-1", entries)).toBe(1);
  });

  it("投入順(FIFO)が複数件で正しく反映される", () => {
    const entries = [entry("job-3", 20), entry("job-1", 0), entry("job-2", 10)];
    expect(queuePosition("job-1", entries)).toBe(1);
    expect(queuePosition("job-2", entries)).toBe(2);
    expect(queuePosition("job-3", entries)).toBe(3);
    expect(isQueueHead("job-1", entries)).toBe(true);
    expect(isQueueHead("job-2", entries)).toBe(false);
  });

  it("自分がエントリに含まれていなければ順位はnull", () => {
    const entries = [entry("job-1", 0)];
    expect(queuePosition("job-missing", entries)).toBeNull();
  });

  it("死んだ待機者(stale)を先に除外すれば、後続が先頭になる(head-of-line blocking対策)", () => {
    const allEntries = [
      entry("job-1", -10, GPU_QUEUE_STALE_AFTER_SECONDS + 1), // stale
      entry("job-2", 0),
    ];
    const live = excludeStaleEntries(allEntries, NOW);
    expect(isQueueHead("job-2", live)).toBe(true);
    expect(queuePosition("job-2", live)).toBe(1);
  });
});
