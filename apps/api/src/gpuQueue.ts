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

/**
 * 待機列エントリの心拍が陳腐化しているか。未設定・不正な値（壊れたデータ）は
 * 最も古い扱い＝staleとして安全側（除外）に倒す。
 */
export function isQueueHeartbeatStale(gpuQueueHeartbeatAt: string | undefined, now: Date): boolean {
  const heartbeatMs = gpuQueueHeartbeatAt ? Date.parse(gpuQueueHeartbeatAt) : Number.NaN;
  if (Number.isNaN(heartbeatMs)) {
    return true;
  }
  return isHeartbeatStale((now.getTime() - heartbeatMs) / 1000);
}

/** 心拍が陳腐化していないエントリだけを残す。 */
export function excludeStaleEntries(entries: readonly QueueEntry[], now: Date): QueueEntry[] {
  return entries.filter((entry) => !isQueueHeartbeatStale(entry.gpuQueueHeartbeatAt, now));
}

/**
 * 自分より前にいる（`gpuQueuedAt`が古い）エントリを返す。`liveEntries`は事前に
 * `excludeStaleEntries()`を通しておくこと。`gpuQueuedAt`が同一ミリ秒で並んだ
 * 場合は`jobId`で決定的に順序付ける（さもないと双方が互いを「前にいない」と見て
 * 同時に先頭と判定してしまう）。
 */
export function entriesAhead(jobId: string, liveEntries: readonly QueueEntry[]): QueueEntry[] {
  const mine = liveEntries.find((entry) => entry.jobId === jobId);
  if (!mine) {
    return [];
  }
  return liveEntries.filter(
    (entry) =>
      entry.jobId !== jobId &&
      (entry.gpuQueuedAt < mine.gpuQueuedAt ||
        (entry.gpuQueuedAt === mine.gpuQueuedAt && entry.jobId < mine.jobId)),
  );
}

/**
 * 自分が待機列の先頭か（stale除外後、自分より古い`gpuQueuedAt`が無いか）。
 * 自分自身がエントリに含まれていなければ順位を判定できないため、追い越しを
 * 避けて先頭でない側（false）に倒す。
 */
export function isQueueHead(jobId: string, liveEntries: readonly QueueEntry[]): boolean {
  if (!liveEntries.some((entry) => entry.jobId === jobId)) {
    return false;
  }
  return entriesAhead(jobId, liveEntries).length === 0;
}

/** 待機列での順位（1始まり）。自分自身がエントリに含まれていなければnull。 */
export function queuePosition(jobId: string, liveEntries: readonly QueueEntry[]): number | null {
  if (!liveEntries.some((entry) => entry.jobId === jobId)) {
    return null;
  }
  return entriesAhead(jobId, liveEntries).length + 1;
}
