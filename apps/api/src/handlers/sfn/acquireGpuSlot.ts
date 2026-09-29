import {
  GPU_JOB_OVERHEAD_SECONDS,
  GPU_MAX_INSTANCE_VCPU,
  GPU_MIN_INSTANCE_VCPU,
  GPU_QUEUE_FALLBACK_DURATION_SECONDS,
  GPU_VCPU_QUOTA,
  isQueueWaitTimedOut,
  nextPollIntervalSeconds,
  requiresGpuRecording,
  reservableVcpu,
} from "@sattori/shared";
import { loadConfig } from "../../config.js";
import { acquireGpuSlot, listGpuSlots } from "../../gpuSlots.js";
import { getJob, updateJobStatus } from "../../jobs.js";

/**
 * Step Functions の `AcquireGpuSlot` ステート（通常invoke、`Launch`の手前）から
 * 呼ばれるLambda（Issue #270）。GPU描画必須タイトル（th06nc・th15）のvCPU容量を
 * `GpuSlotsTable` で会計し、空きが無ければ `Launch` へ進ませずに待たせる。
 *
 * **これはPR1の実装で、投入順（FIFO）は保証しない**（早い者勝ち）。順序保証・
 * 心拍による自己修復・待機専用のタイムアウト起点（`gpuQueueEnteredAt`）は後続の
 * 変更で追加する。詳細は `docs/decisions/0056-gpu-vcpu-lease-and-queue.md`。
 *
 * タイムアウト判定は、このPR1時点ではまだ待機専用の状態を`JobsTable`に持たない
 * ため、Step Functions実行のコンテキストオブジェクト（`$$.Execution.StartTime`）を
 * 経過時間の基準に使う——ジョブが`queued`になった時刻とほぼ一致する近似値で、
 * 「待てば必ず順番が回る」という基本価値を素早く出すための割り切り。FIFO順序を
 * 追加する変更で、リトライ（`HandleFailure`後の再入）ごとに待機の猶予がリセットされる
 * 専用の起点（`gpuQueueEnteredAt`）へ置き換える。
 *
 * 非GPUジョブは`GpuSlotsTable`に一切触れず即座に`acquired: true`を返す
 * （ADR 0010「環境差分はワーカー側の分岐ではなく起動側で表す」と同じ精神）。
 */
export interface AcquireGpuSlotEvent {
  jobId: string;
  attempt: number;
  /** Step Functionsのコンテキストオブジェクトから渡る、実行開始時刻（ISO 8601）。 */
  executionStartTime: string;
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
  const startTimeMs = Date.parse(event.executionStartTime);
  const elapsedSeconds = Number.isNaN(startTimeMs)
    ? 0
    : Math.max(0, (now.getTime() - startTimeMs) / 1000);
  if (isQueueWaitTimedOut(elapsedSeconds)) {
    await updateJobStatus(
      config.jobsTable,
      event.jobId,
      "failed",
      "GPU録画の混雑により待ち時間の上限を超えました。時間をおいて再試行してください",
      { unlessDone: true, errorCode: "gpu_queue_timeout" },
    );
    console.log(
      JSON.stringify({ event: "gpu_queue_timed_out", jobId: event.jobId, attempt: event.attempt }),
    );
    return { jobId: event.jobId, attempt: event.attempt, acquired: false, timedOut: true, waitSeconds: 0 };
  }

  const { usedVcpu } = await listGpuSlots(config.gpuSlotsTable);
  // attempt > 1 の場合（前回のLaunchが失敗した再試行）、4vCPUでの起動（g6f.xlarge単独）が
  // 在庫枯渇等で失敗した可能性がある。4vCPUのまま再試行を繰り返すとMAX_ATTEMPTS(10回≒27分)を
  // 浪費して先行ジョブの完了(8vCPU回復)を待たずにretries_exhaustedで失敗してしまうため、
  // リトライ時は最大候補タイプ分(GPU_MAX_INSTANCE_VCPU=8vCPU、g6f.2xlargeも選べる量)が
  // 空くまで待機列で待たせる。
  // 初回(attempt === 1)は4vCPUの空きがあれば投機的に並列起動を試みる。
  const minRequiredVcpu = event.attempt > 1 ? GPU_MAX_INSTANCE_VCPU : GPU_MIN_INSTANCE_VCPU;
  const reserve = reservableVcpu(GPU_VCPU_QUOTA - usedVcpu, minRequiredVcpu);
  if (reserve === null) {
    console.log(
      JSON.stringify({ event: "gpu_slot_wait", jobId: event.jobId, attempt: event.attempt, usedVcpu }),
    );
    return {
      jobId: event.jobId,
      attempt: event.attempt,
      acquired: false,
      timedOut: false,
      waitSeconds: nextPollIntervalSeconds(elapsedSeconds),
    };
  }

  const expectedFinishAt = computeExpectedFinishAt(job.estimatedDurationSeconds, now);
  const result = await acquireGpuSlot(config.gpuSlotsTable, event.jobId, reserve, now, expectedFinishAt);
  if (result.kind === "no_capacity") {
    // 事前チェック(listGpuSlots)と実際の確保の間に他のジョブが割り込んだ。
    console.log(
      JSON.stringify({ event: "gpu_slot_contended", jobId: event.jobId, attempt: event.attempt }),
    );
    return {
      jobId: event.jobId,
      attempt: event.attempt,
      acquired: false,
      timedOut: false,
      waitSeconds: nextPollIntervalSeconds(elapsedSeconds),
    };
  }

  console.log(
    JSON.stringify({
      event: "gpu_slot_acquired",
      jobId: event.jobId,
      attempt: event.attempt,
      vcpu: result.lease.vcpu,
    }),
  );
  return { jobId: event.jobId, attempt: event.attempt, acquired: true, timedOut: false, waitSeconds: 0 };
};
