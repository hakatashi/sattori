import { SFNClient } from "@aws-sdk/client-sfn";
import { required } from "../config.js";
import { listTaggedInstances, terminateInstance } from "../ec2.js";
import type { TaggedInstance } from "../ec2.js";
import { getJob } from "../jobs.js";
import { groupInstancesByJobId, selectOrphanInstances } from "../orphanInstances.js";
import type { OrphanCandidate } from "../orphanInstances.js";
import { buildExecutionArn, getExecutionLiveness } from "../stepFunctions.js";

const sfn = new SFNClient({});

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

  const instances = await listTaggedInstances();
  const byJobId = groupInstancesByJobId(instances);

  const result: SweepResult = {
    scanned: instances.length,
    orphans: 0,
    terminated: 0,
    skippedJobs: 0,
  };

  for (const [jobId, jobInstances] of byJobId) {
    const candidates = await selectForJob(jobsTable, stateMachineArn, jobId, jobInstances);
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

  console.log(JSON.stringify({ event: "orphan_sweep_completed", ...result }));
  return result;
};

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
): Promise<OrphanCandidate[] | null> {
  let executionLiveness;
  try {
    executionLiveness = await getExecutionLiveness(
      sfn,
      buildExecutionArn(stateMachineArn, jobId),
    );
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "orphan_sweep_describe_execution_failed",
        jobId,
        message: err instanceof Error ? err.message : String(err),
      }),
    );
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
