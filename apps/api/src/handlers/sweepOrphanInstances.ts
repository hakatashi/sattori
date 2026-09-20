import { SFNClient } from "@aws-sdk/client-sfn";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { GPU_QUEUE_INDEX, GPU_QUEUE_WAITING, isHeartbeatStale } from "@sattori/shared";
import { required } from "../config.js";
import { listTaggedInstances, terminateInstance } from "../ec2.js";
import type { TaggedInstance } from "../ec2.js";
import {
  isReclaimableLease,
  isUnleasedInstanceNeedingLease,
  observeGpuUsage,
  selectDriftedLeases,
} from "../gpuReconcile.js";
import {
  createCompensatingGpuLease,
  listGpuSlots,
  releaseGpuSlot,
  repairGpuLeaseVcpu,
} from "../gpuSlots.js";
import { clearGpuQueueState, getJob } from "../jobs.js";
import { groupInstancesByJobId, selectOrphanInstances } from "../orphanInstances.js";
import type { OrphanCandidate } from "../orphanInstances.js";
import { buildExecutionArn, getExecutionLiveness } from "../stepFunctions.js";
import type { ExecutionLiveness } from "../stepFunctions.js";

const sfn = new SFNClient({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/** 1回の掃除の結果。CloudWatch Logsに残す運用把握用のサマリ。 */
export interface SweepResult {
  /** タグから見つかった生存インスタンスの総数。 */
  scanned: number;
  /** 孤児と判定したインスタンス数。 */
  orphans: number;
  /** 実際に terminate に成功した数。 */
  terminated: number;
  /** 実行の生死や失敗のため判定を見送ったジョブ数。 */
  skippedJobs: number;
  /** GPU vCPU容量リース（Issue #270）のうち、回収したリース数。 */
  leasesReclaimed: number;
  /** vCPU数のドリフトを補正したリース数。 */
  leasesRepaired: number;
  /** リースが無い生存GPUインスタンスに対し、補完リースを作成した数。 */
  leasesCompensated: number;
  /** 心拍が陳腐化した待機列(GpuQueueIndex)のエントリを剥がした数。 */
  staleQueueEntriesCleared: number;
}

/**
 * EventBridgeのスケジュールルール（`ORPHAN_SWEEP_INTERVAL_MINUTES`間隔）から呼ばれる、
 * 孤児EC2インスタンスの掃除役（Issue #23）。
 *
 * ジョブの後始末（`sfn/handleFailure.ts`・`admin/stopJob.ts`）がどれも「そのハンドラ
 * 自体が動けたなら」という前提に立っているのに対し、こちらは**AWS上に実在する
 * インスタンスを起点に走査する**ので、`instanceId` を書き残せずに死んだ `Launch` の
 * 孤児も拾える。判定の根拠と安全側への倒し方は `orphanInstances.ts` 参照。
 *
 * 1ジョブぶんの調査・terminateが失敗しても他のジョブの掃除は続ける（1台の孤児が
 * 他の孤児を道連れに見逃されるのを防ぐ）。ただし**インスタンスの列挙自体に失敗した
 * ときは例外がそのまま出る** — 何も掃除できなかったことを実行の失敗として残さないと、
 * 「毎回起動しているのに永久に何もしていない」状態が正常に見えてしまうため。
 */
export const handler = async (): Promise<SweepResult> => {
  const jobsTable = required("JOBS_TABLE");
  const stateMachineArn = required("STATE_MACHINE_ARN");
  const gpuSlotsTable = required("GPU_SLOTS_TABLE");

  const instances = await listTaggedInstances();
  const byJobId = groupInstancesByJobId(instances);
  // 実行の生死は孤児インスタンス掃除・GPUリース回収の両方が同じjobIdについて
  // 問い合わせうるため、`DescribeExecution`呼び出しを重複させないようキャッシュする。
  const livenessCache = new Map<string, ExecutionLiveness | null>();

  const result: SweepResult = {
    scanned: instances.length,
    orphans: 0,
    terminated: 0,
    skippedJobs: 0,
    leasesReclaimed: 0,
    leasesRepaired: 0,
    leasesCompensated: 0,
    staleQueueEntriesCleared: 0,
  };

  const terminatedIds = new Set<string>();

  for (const [jobId, jobInstances] of byJobId) {
    const candidates = await selectForJob(jobsTable, stateMachineArn, jobId, jobInstances, livenessCache);
    if (candidates === null) {
      result.skippedJobs += 1;
      continue;
    }
    result.orphans += candidates.length;
    for (const candidate of candidates) {
      console.warn(
        JSON.stringify({
          event: "orphan_instance_detected",
          jobId: candidate.jobId,
          instanceId: candidate.instanceId,
          reason: candidate.reason,
        }),
      );
      try {
        await terminateInstance(candidate.instanceId);
        result.terminated += 1;
        terminatedIds.add(candidate.instanceId);
      } catch (err) {
        console.error(
          JSON.stringify({
            event: "orphan_instance_terminate_failed",
            jobId: candidate.jobId,
            instanceId: candidate.instanceId,
            message: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    }
  }

  // terminateに成功したインスタンスを除外したリストをリコンサイラへ渡す。
  // これを怠ると、直前にterminateした孤児GPUインスタンスに対し「リースが無い生存
  // インスタンス」として誤って補完リース(createCompensatingGpuLease)を作成してしまい、
  // 存在しないインスタンスのために4〜8vCPUが最大10分間ブロックされてしまう。
  const liveInstances = instances.filter((inst) => !terminatedIds.has(inst.instanceId));
  await reconcileGpuSlots(jobsTable, gpuSlotsTable, stateMachineArn, liveInstances, livenessCache, result);

  console.log(JSON.stringify({ event: "orphan_sweep_completed", ...result }));
  return result;
};

/** `DescribeExecution`の結果をjobId単位でキャッシュしつつ問い合わせる。判定不能はnull。 */
async function getCachedExecutionLiveness(
  cache: Map<string, ExecutionLiveness | null>,
  stateMachineArn: string,
  jobId: string,
): Promise<ExecutionLiveness | null> {
  if (cache.has(jobId)) {
    return cache.get(jobId) ?? null;
  }
  try {
    const liveness = await getExecutionLiveness(sfn, buildExecutionArn(stateMachineArn, jobId));
    cache.set(jobId, liveness);
    return liveness;
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "sweep_describe_execution_failed",
        jobId,
        message: err instanceof Error ? err.message : String(err),
      }),
    );
    cache.set(jobId, null);
    return null;
  }
}

/**
 * GPU vCPU容量リース（Issue #270）のリコンサイラ。実在するGPUインスタンス
 * （`instances`）を「事実」として`GpuSlotsTable`の台帳を補正する。判定ロジックは
 * `gpuReconcile.ts`（純粋関数）、書き込みは`gpuSlots.ts`に集約してある。
 *
 * 台帳の列挙自体が失敗した場合はログのみに残して見送る（次回の掃除に委ねる。
 * 孤児インスタンス掃除本体は継続させたいので、ここで例外を投げない）。
 */
async function reconcileGpuSlots(
  jobsTable: string,
  gpuSlotsTable: string,
  stateMachineArn: string,
  instances: TaggedInstance[],
  livenessCache: Map<string, ExecutionLiveness | null>,
  result: SweepResult,
): Promise<void> {
  let leases;
  try {
    ({ leases } = await listGpuSlots(gpuSlotsTable));
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "gpu_reconcile_list_failed",
        message: err instanceof Error ? err.message : String(err),
      }),
    );
    return;
  }

  const now = new Date();
  const { vcpuByJobId, unleasedInstances } = observeGpuUsage(instances, leases);

  // 1. vCPUドリフトの補正(shrinkGpuLease失敗の後始末)。生存インスタンスがある
  // ジョブのリースのみが対象(selectDriftedLeasesはvcpuByJobIdに実測が無いジョブを
  // 除外する)ため、下の回収ループとは互いに素な集合を扱う。
  for (const drift of selectDriftedLeases(leases, vcpuByJobId)) {
    await repairGpuLeaseVcpu(gpuSlotsTable, drift.jobId, drift.observedVcpu);
    result.leasesRepaired += 1;
  }

  // 2. 期限切れ・孤児化したリースの回収(release/handleFailure失敗の後始末)。
  for (const lease of leases) {
    const hasLiveInstance = vcpuByJobId.has(lease.jobId);
    const executionLiveness = await getCachedExecutionLiveness(livenessCache, stateMachineArn, lease.jobId);
    if (executionLiveness === null) {
      continue;
    }
    if (!isReclaimableLease({ lease, hasLiveInstance, executionLiveness, now })) {
      continue;
    }
    try {
      await releaseGpuSlot(gpuSlotsTable, lease.jobId);
      result.leasesReclaimed += 1;
      console.warn(JSON.stringify({ event: "gpu_lease_reclaimed", jobId: lease.jobId }));
    } catch (err) {
      console.error(
        JSON.stringify({
          event: "gpu_lease_reclaim_failed",
          jobId: lease.jobId,
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  // 3. リースが無い生存GPUインスタンスへの補完リース作成(acquireGpuSlot失敗の
  // 後始末。安全側=クオータ超過側に倒す)。
  for (const unleased of unleasedInstances) {
    if (!isUnleasedInstanceNeedingLease(unleased.launchTime, now)) {
      continue;
    }
    await createCompensatingGpuLease(
      gpuSlotsTable,
      unleased.jobId,
      unleased.vcpu,
      unleased.launchTime ?? now,
    );
    result.leasesCompensated += 1;
  }

  // 4. 心拍が陳腐化した待機列(GpuQueueIndex)エントリの剥がし
  // （head-of-line blocking対策の最終網。`AcquireGpuSlot`の先頭判定・順位計算は
  // 都度stale除外するため誤動作はしないが、取り残された属性がsparse GSIに残り
  // 続けるのを防ぐ）。実行が生きていない場合のみ剥がす——起動直後で心拍がまだ
  // 新鮮でないだけの正常なジョブを誤って剥がさないための安全策。
  try {
    const waiting = await ddb.send(
      new QueryCommand({
        TableName: jobsTable,
        IndexName: GPU_QUEUE_INDEX,
        KeyConditionExpression: "gpuQueueState = :waiting",
        ExpressionAttributeValues: { ":waiting": GPU_QUEUE_WAITING },
      }),
    );
    for (const item of (waiting.Items ?? []) as Array<{ jobId: string; gpuQueueHeartbeatAt?: string }>) {
      const heartbeatMs = item.gpuQueueHeartbeatAt ? Date.parse(item.gpuQueueHeartbeatAt) : NaN;
      const ageSeconds = Number.isNaN(heartbeatMs)
        ? Number.POSITIVE_INFINITY
        : (now.getTime() - heartbeatMs) / 1000;
      if (!isHeartbeatStale(ageSeconds)) {
        continue;
      }
      const executionLiveness = await getCachedExecutionLiveness(livenessCache, stateMachineArn, item.jobId);
      if (executionLiveness === null || executionLiveness === "running") {
        continue;
      }
      await clearGpuQueueState(jobsTable, item.jobId);
      result.staleQueueEntriesCleared += 1;
      console.warn(JSON.stringify({ event: "gpu_queue_stale_entry_cleared", jobId: item.jobId }));
    }
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "gpu_queue_reconcile_list_failed",
        message: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

/**
 * 1ジョブぶんの孤児候補を求める。判定に必要な情報が揃わなかった場合は null を返し、
 * 呼び出し側はそのジョブを**丸ごと見送る**（次回の掃除で改めて拾えばよい。
 * 判定できないまま terminate するのは、動いている録画を殺しうるので許されない）。
 *
 * ジョブレコードが存在しない場合は判定を続ける。`stopRequestedAt` が読めないだけで、
 * 実行の生死という主たる根拠は `DescribeExecution` から得られているため
 * （むしろ「レコードが消えているのにインスタンスが生きている」は孤児の典型）。
 */
async function selectForJob(
  jobsTable: string,
  stateMachineArn: string,
  jobId: string,
  instances: TaggedInstance[],
  livenessCache: Map<string, ExecutionLiveness | null>,
): Promise<OrphanCandidate[] | null> {
  const executionLiveness = await getCachedExecutionLiveness(livenessCache, stateMachineArn, jobId);
  if (executionLiveness === null) {
    return null;
  }

  let stopRequested = false;
  try {
    const job = await getJob(jobsTable, jobId);
    stopRequested = job?.stopRequestedAt != null;
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "orphan_sweep_get_job_failed",
        jobId,
        message: err instanceof Error ? err.message : String(err),
      }),
    );
    return null;
  }

  return selectOrphanInstances({
    instances,
    executionLiveness,
    stopRequested,
    now: new Date(),
  });
}
