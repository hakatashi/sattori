import {
  estimateQueueWaitSeconds,
  GPU_JOB_OVERHEAD_SECONDS,
  GPU_QUEUE_FALLBACK_DURATION_SECONDS,
  GPU_QUEUE_INDEX,
  GPU_QUEUE_WAITING,
  GPU_VCPU_QUOTA,
  isQueueWaitTimedOut,
  nextPollIntervalSeconds,
  requiresGpuRecording,
  reservableVcpu,
} from "@sattori/shared";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { loadConfig } from "../../config.js";
import { entriesAhead, excludeStaleEntries, isQueueHead, queuePosition } from "../../gpuQueue.js";
import type { QueueEntry } from "../../gpuQueue.js";
import { acquireGpuSlot, listGpuSlots } from "../../gpuSlots.js";
import {
  clearGpuQueueState,
  getJob,
  markGpuQueueWaiting,
  updateGpuQueueDisplay,
  updateJobStatus,
} from "../../jobs.js";

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/**
 * Step Functions の `AcquireGpuSlot` ステート（通常invoke、`Launch`の手前）から
 * 呼ばれるLambda（Issue #270）。GPU描画必須タイトル（th06nc・th15）のvCPU容量を
 * `GpuSlotsTable` で会計し、投入順（FIFO、`JobsTable`のsparse GSI
 * `GpuQueueIndex`）を守りながら空きを待たせる。
 *
 * 非GPUジョブは`JobsTable`の`gpuQueue*`属性にも`GpuSlotsTable`にも一切触れず
 * 即座に`acquired: true`を返す（ADR 0010「環境差分はワーカー側の分岐ではなく
 * 起動側で表す」と同じ精神）。
 *
 * ## 処理の流れ（GPUジョブのみ）
 *
 * 1. `markGpuQueueWaiting()`で待機列に入る（冪等。`gpuQueuedAt`は初回のみセット）。
 * 2. `gpuQueueEnteredAt`からの経過でタイムアウト判定。超過なら`failed`を書いて
 *    待機列から外し、`timedOut: true`を返す。
 * 3. `GpuQueueIndex`をQueryし、心拍が陳腐化した待機者（head-of-line blocking
 *    対策）を除外したうえで、自分が列の先頭かを判定する。
 * 4. 先頭なら`GpuSlotsTable`の空きを見て確保を試みる。取れたら待機列から外し
 *    `acquired: true`。先頭でない・取れなかった場合は順位・推定待ち時間を
 *    `JobsTable`へ書き（表示用）、`waitSeconds`を返す。
 *
 * 詳細は `docs/decisions/0056-gpu-vcpu-lease-and-queue.md`。
 */
export interface AcquireGpuSlotEvent {
  jobId: string;
  attempt: number;
}

export interface AcquireGpuSlotResult {
  jobId: string;
  attempt: number;
  /** 枠を確保できたか。true なら `Launch` ステートへ進む。 */
  acquired: boolean;
  /** 待機の上限（`GPU_QUEUE_MAX_WAIT_MINUTES`）を超えて失敗確定したか。 */
  timedOut: boolean;
  /** `acquired: false` のとき、次に `AcquireGpuSlot` を呼び直すまでの待機秒数。 */
  waitSeconds: number;
}

function computeExpectedFinishAt(estimatedDurationSeconds: number | null, now: Date): Date {
  const durationSeconds = estimatedDurationSeconds ?? GPU_QUEUE_FALLBACK_DURATION_SECONDS;
  return new Date(now.getTime() + (durationSeconds + GPU_JOB_OVERHEAD_SECONDS) * 1000);
}

/** `GpuQueueIndex`から待機中の全ジョブを取得する（Projection=ALLなので順位・ETA計算に要る属性も同時に読める）。 */
async function queryWaitingJobs(
  table: string,
): Promise<{ jobId: string; gpuQueuedAt: string; gpuQueueHeartbeatAt: string; estimatedDurationSeconds: number | null }[]> {
  const result = await client.send(
    new QueryCommand({
      TableName: table,
      IndexName: GPU_QUEUE_INDEX,
      KeyConditionExpression: "gpuQueueState = :waiting",
      ExpressionAttributeValues: { ":waiting": GPU_QUEUE_WAITING },
    }),
  );
  const items = (result.Items ?? []) as Array<{
    jobId: string;
    gpuQueuedAt: string;
    gpuQueueHeartbeatAt?: string;
    estimatedDurationSeconds?: number | null;
  }>;
  return items.map((item) => ({
    jobId: item.jobId,
    gpuQueuedAt: item.gpuQueuedAt,
    // 心拍未設定（理屈上到達不能だが、GSIの結果整合による古いスナップショットを
    // 拾った場合を想定）は最も古い扱いにして安全側（stale除外）に倒す。
    gpuQueueHeartbeatAt: item.gpuQueueHeartbeatAt ?? new Date(0).toISOString(),
    estimatedDurationSeconds: item.estimatedDurationSeconds ?? null,
  }));
}

export const handler = async (event: AcquireGpuSlotEvent): Promise<AcquireGpuSlotResult> => {
  const config = loadConfig();
  const job = await getJob(config.jobsTable, event.jobId);
  if (!job) {
    throw new Error(`ジョブが見つかりません: ${event.jobId}`);
  }

  if (!requiresGpuRecording(job.game)) {
    return { jobId: event.jobId, attempt: event.attempt, acquired: true, timedOut: false, waitSeconds: 0 };
  }

  const now = new Date();
  const mark = await markGpuQueueWaiting(config.jobsTable, event.jobId);
  if (!mark.marked) {
    // stopRequestedAt(緊急停止済み)。どのみちStep Functions実行自体が停止される
    // ため、ここでは待機扱いにするだけで安全（次に呼ばれることはない想定）。
    console.log(
      JSON.stringify({ event: "gpu_queue_skip_stopped", jobId: event.jobId, attempt: event.attempt }),
    );
    return { jobId: event.jobId, attempt: event.attempt, acquired: false, timedOut: false, waitSeconds: 60 };
  }

  const elapsedSeconds = Math.max(0, (now.getTime() - Date.parse(mark.gpuQueueEnteredAt)) / 1000);
  if (isQueueWaitTimedOut(elapsedSeconds)) {
    await updateJobStatus(
      config.jobsTable,
      event.jobId,
      "failed",
      "GPU録画の混雑により待ち時間の上限を超えました。時間をおいて再試行してください",
      { unlessDone: true, errorCode: "gpu_queue_timeout" },
    );
    await clearGpuQueueState(config.jobsTable, event.jobId);
    console.log(
      JSON.stringify({ event: "gpu_queue_timed_out", jobId: event.jobId, attempt: event.attempt }),
    );
    return { jobId: event.jobId, attempt: event.attempt, acquired: false, timedOut: true, waitSeconds: 0 };
  }

  const waitingJobs = await queryWaitingJobs(config.jobsTable);
  const allEntries: QueueEntry[] = waitingJobs.map((w) => ({
    jobId: w.jobId,
    gpuQueuedAt: w.gpuQueuedAt,
    gpuQueueHeartbeatAt: w.gpuQueueHeartbeatAt,
  }));
  const liveEntries = excludeStaleEntries(allEntries, now);
  const head = isQueueHead(event.jobId, liveEntries);

  if (head) {
    const { usedVcpu, leases } = await listGpuSlots(config.gpuSlotsTable);
    const reserve = reservableVcpu(GPU_VCPU_QUOTA - usedVcpu);
    if (reserve !== null) {
      const expectedFinishAt = computeExpectedFinishAt(job.estimatedDurationSeconds, now);
      const result = await acquireGpuSlot(
        config.gpuSlotsTable,
        event.jobId,
        reserve,
        now,
        expectedFinishAt,
      );
      if (result.kind === "acquired") {
        await clearGpuQueueState(config.jobsTable, event.jobId);
        console.log(
          JSON.stringify({
            event: "gpu_slot_acquired",
            jobId: event.jobId,
            attempt: event.attempt,
            vcpu: result.lease.vcpu,
          }),
        );
        return { jobId: event.jobId, attempt: event.attempt, acquired: true, timedOut: false, waitSeconds: 0 };
      }
      // listGpuSlotsと実際の確保の間に他のジョブ(=別リージョン呼び出しのラグ等)が
      // 割り込んだ。FIFOの先頭同士が同時にAcquireGpuSlotへ来ることは無いはずだが、
      // リコンサイラの補完リース作成等と競合しうるため、ここでも待機側へ倒す。
      console.log(
        JSON.stringify({ event: "gpu_slot_contended", jobId: event.jobId, attempt: event.attempt }),
      );
    }
    // 先頭だが空きが無い場合、ETA計算用に実行中リースの残り時間を使う。
    const position = 1;
    const waitSeconds = nextPollIntervalSeconds(elapsedSeconds);
    const etaSeconds = estimateQueueWaitSeconds(
      [],
      leases.map((l) => ({ expectedFinishAtMs: Date.parse(l.expectedFinishAt) })),
      now.getTime(),
    );
    await updateGpuQueueDisplay(config.jobsTable, event.jobId, position, etaSeconds);
    console.log(
      JSON.stringify({ event: "gpu_slot_wait", jobId: event.jobId, attempt: event.attempt, usedVcpu, position }),
    );
    return { jobId: event.jobId, attempt: event.attempt, acquired: false, timedOut: false, waitSeconds };
  }

  // 先頭でない: 順位・ETAを計算して待つ。
  const position = queuePosition(event.jobId, liveEntries) ?? liveEntries.length + 1;
  const ahead = entriesAhead(event.jobId, liveEntries);
  const aheadDurations = ahead.map((entry) => ({
    estimatedDurationSeconds:
      waitingJobs.find((w) => w.jobId === entry.jobId)?.estimatedDurationSeconds ?? null,
  }));
  const { leases } = await listGpuSlots(config.gpuSlotsTable);
  const etaSeconds = estimateQueueWaitSeconds(
    aheadDurations,
    leases.map((l) => ({ expectedFinishAtMs: Date.parse(l.expectedFinishAt) })),
    now.getTime(),
  );
  const waitSeconds = nextPollIntervalSeconds(elapsedSeconds);
  await updateGpuQueueDisplay(config.jobsTable, event.jobId, position, etaSeconds);
  console.log(
    JSON.stringify({ event: "gpu_slot_wait", jobId: event.jobId, attempt: event.attempt, position, etaSeconds }),
  );
  return { jobId: event.jobId, attempt: event.attempt, acquired: false, timedOut: false, waitSeconds };
};
