import { SFNClient } from "@aws-sdk/client-sfn";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { JobRecord, JobStatus } from "@sattori/shared";
import { required } from "../config.js";
import { updateJobStatus } from "../jobs.js";
import { isStalledJob } from "../stalledJobs.js";
import { buildExecutionArn, getExecutionLiveness } from "../stepFunctions.js";

const sfn = new SFNClient({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/** `infra/lib/sattori-stack.ts`が張るGSI。`apps/api/src/adminJobs.ts`と同じもの。 */
const STATUS_CREATED_AT_INDEX = "StatusCreatedAtIndex";

/**
 * 掃除対象の非終端status。`JOB_STATUSES`の非終端ぶんから`pending`を除いたもの
 * （`stalledJobs.ts`の`isStalledJob`も同じ理由で`pending`を対象外にしている）。
 * `pending`はマジックリンク未クリックのまま最大24時間残るのが正常な状態なので、
 * ここで問い合わせの対象から外し、無駄なGSIクエリと`DescribeExecution`呼び出しを
 * 避ける（`pending`のジョブはStep Functions実行自体が存在しない）。
 */
const TARGET_STATUSES: readonly JobStatus[] = ["queued", "launching", "recording", "converting"];

/** 1回の掃除の結果。CloudWatch Logsに残す運用把握用のサマリ。 */
export interface StalledJobSweepResult {
  /** 対象statusのジョブレコード総数。 */
  scanned: number;
  /** 固まったと判定したジョブ数。 */
  stalled: number;
  /** 実際に`failed`への確定に成功した数。 */
  failed: number;
  /** 実行の生死が判定できず見送ったジョブ数。 */
  skippedJobs: number;
}

/**
 * EventBridgeのスケジュールルール（`OrphanInstanceSweepRule`、`ORPHAN_SWEEP_INTERVAL_MINUTES`
 * 間隔）に相乗りして呼ばれる、非終端のまま固まったジョブレコードの掃除役（Issue #132）。
 *
 * 起動直後にLambdaが死ぬ・後始末ハンドラ自体が例外を握り潰す・緊急停止のterminateが
 * 失敗する等、非終端のまま固まる経路は複数あり（AGENTS.md参照）、いずれも「そのハンドラ
 * 自体が動けたなら」という前提に立っている。この掃除役は`sweepOrphanInstances.ts`が
 * AWS上の実インスタンスを起点に走査するのと同じ発想で、**ジョブレコードの`status`を
 * 起点に走査する**ことで、個々の経路がどこで失敗したかによらず一律に拾う。
 *
 * 判定はジョブを`failed`へ倒すだけで、`sweepOrphanInstances.ts`のような破壊的操作
 * （terminate）は伴わない。判定ロジックは`stalledJobs.ts`（純粋関数）参照。
 *
 * 1ジョブぶんの判定・更新が失敗しても他のジョブの掃除は続ける。GSIへのクエリ自体が
 * 失敗した場合は例外をそのまま投げる（`sweepOrphanInstances.ts`と同じ理由——何も
 * 掃除できなかったことを実行の失敗として残さないと、常時失敗している状態が正常に
 * 見えてしまうため）。
 */
export const handler = async (): Promise<StalledJobSweepResult> => {
  const jobsTable = required("JOBS_TABLE");
  const stateMachineArn = required("STATE_MACHINE_ARN");

  const perStatus = await Promise.all(
    TARGET_STATUSES.map((status) => queryJobsByStatus(jobsTable, status)),
  );
  const jobs = perStatus.flat();

  const result: StalledJobSweepResult = { scanned: jobs.length, stalled: 0, failed: 0, skippedJobs: 0 };
  const now = new Date();

  for (const job of jobs) {
    let executionLiveness;
    try {
      executionLiveness = await getExecutionLiveness(
        sfn,
        buildExecutionArn(stateMachineArn, job.jobId),
      );
    } catch (err) {
      console.error(
        JSON.stringify({
          event: "stalled_job_sweep_describe_execution_failed",
          jobId: job.jobId,
          message: err instanceof Error ? err.message : String(err),
        }),
      );
      result.skippedJobs += 1;
      continue;
    }

    if (!isStalledJob({ status: job.status, updatedAt: job.updatedAt, executionLiveness, now })) {
      continue;
    }

    result.stalled += 1;
    console.warn(
      JSON.stringify({
        event: "stalled_job_detected",
        jobId: job.jobId,
        status: job.status,
        updatedAt: job.updatedAt,
        executionLiveness,
      }),
    );
    try {
      const updated = await updateJobStatus(
        jobsTable,
        job.jobId,
        "failed",
        "録画処理が長時間応答しなかったため中断しました。時間をおいて再度リプレイをアップロードしてください",
        { unlessDone: true, errorCode: "stalled" },
      );
      if (updated) {
        result.failed += 1;
      }
    } catch (err) {
      console.error(
        JSON.stringify({
          event: "stalled_job_update_failed",
          jobId: job.jobId,
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  console.log(JSON.stringify({ event: "stalled_job_sweep_completed", ...result }));
  return result;
};

/** 指定status1件ぶんの非終端ジョブを全件取得する（`StatusCreatedAtIndex`をQuery）。 */
async function queryJobsByStatus(table: string, status: JobStatus): Promise<JobRecord[]> {
  const items: JobRecord[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await ddb.send(
      new QueryCommand({
        TableName: table,
        IndexName: STATUS_CREATED_AT_INDEX,
        KeyConditionExpression: "#status = :status",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":status": status },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    items.push(...((result.Items as JobRecord[] | undefined) ?? []));
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey !== undefined);
  return items;
}
