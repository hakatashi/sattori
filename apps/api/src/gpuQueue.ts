import { isHeartbeatStale } from "@sattori/shared";

/**
 * GPU vCPU容量リース（Issue #270）の待ち行列（FIFO順序）に関する純粋関数。
 * AWS APIを呼ばないロジックだけをここに置き、実際の`GpuQueueIndex`へのQuery・
 * 書き込みは`handlers/sfn/acquireGpuSlot.ts`が行う（`orphanInstances.ts`・
 * `stalledJobs.ts`と同じ分離）。
 *
 * FIFO順の基準は`gpuQueuedAt`（sparse GSI `GpuQueueIndex`のソートキー）。
 * 死んだ待機者（管理画面の緊急停止・Lambdaクラッシュ等で`gpuQueueState`が
 * 取り残されたもの）が列を永久に塞がないよう、`gpuQueueHeartbeatAt`が陳腐化した
 * エントリは先頭判定・順位計算から除外する（head-of-line blocking対策）。
 * 詳細は`docs/decisions/0056-gpu-vcpu-lease-and-queue.md`。
 */

export interface QueueEntry {
  jobId: string;
  /** ISO 8601。FIFO順の基準。 */
  gpuQueuedAt: string;
  /** ISO 8601。生存証明。 */
  gpuQueueHeartbeatAt: string;
}

function heartbeatAgeSeconds(entry: QueueEntry, now: Date): number {
  const heartbeatMs = Date.parse(entry.gpuQueueHeartbeatAt);
  // 不正な値（壊れたデータ）は最も古い扱い＝staleとして安全側（除外）に倒す。
  if (Number.isNaN(heartbeatMs)) {
    return Number.POSITIVE_INFINITY;
  }
  return (now.getTime() - heartbeatMs) / 1000;
}

/** 心拍が陳腐化していないエントリだけを残す。 */
export function excludeStaleEntries(entries: readonly QueueEntry[], now: Date): QueueEntry[] {
  return entries.filter((entry) => !isHeartbeatStale(heartbeatAgeSeconds(entry, now)));
}

/**
 * 自分より前にいる（`gpuQueuedAt`が古い）エントリを返す。`liveEntries`は事前に
 * `excludeStaleEntries()`を通しておくこと。
 */
export function entriesAhead(jobId: string, liveEntries: readonly QueueEntry[]): QueueEntry[] {
  const mine = liveEntries.find((entry) => entry.jobId === jobId);
  if (!mine) {
    return [];
  }
  return liveEntries.filter(
    (entry) => entry.jobId !== jobId && entry.gpuQueuedAt < mine.gpuQueuedAt,
  );
}

/** 自分が待機列の先頭か（stale除外後、自分より古い`gpuQueuedAt`が無いか）。 */
export function isQueueHead(jobId: string, liveEntries: readonly QueueEntry[]): boolean {
  return entriesAhead(jobId, liveEntries).length === 0;
}

/** 待機列での順位（1始まり）。自分自身がエントリに含まれていなければnull。 */
export function queuePosition(jobId: string, liveEntries: readonly QueueEntry[]): number | null {
  if (!liveEntries.some((entry) => entry.jobId === jobId)) {
    return null;
  }
  return entriesAhead(jobId, liveEntries).length + 1;
}
