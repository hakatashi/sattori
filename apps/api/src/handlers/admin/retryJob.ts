import { randomUUID } from "node:crypto";
import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import { isTerminalStatus } from "@sattori/shared";
import type { AdminRetryJobResponse, JobRecord } from "@sattori/shared";
import { loadConfig, required } from "../../config.js";
import { objectExists } from "../../downloads.js";
import { error, json } from "../../http.js";
import { getJob, putJob, updateJobRetryLink, updateJobStatus } from "../../jobs.js";
import { INITIAL_ATTEMPT } from "../../retryPolicy.js";
import type { LaunchTaskEvent } from "../sfn/launch.js";

const sfn = new SFNClient({});

/**
 * 元ジョブから再実行用の新しいジョブレコードを組み立てる。`replayKey`/`game`/
 * `options`/`email`/`language`/`replayInfo`/`estimatedDurationSeconds` は引き継ぎ、
 * 実行結果に属する値（出力パス・進捗・インスタンス情報・エラー）はすべて初期化する。
 *
 * スプレッドで引き継いだ上で明示的に上書きする形にしているのは、`JobRecord` に
 * 「入力側」のフィールドが増えた際に引き継ぎ漏れが起きないようにするため
 * （逆に「結果側」のフィールドが増えた場合はここに初期化を足す必要がある）。
 */
export function buildRetryJob(source: JobRecord, newJobId: string, now: Date): JobRecord {
  const timestamp = now.toISOString();
  return {
    ...source,
    jobId: newJobId,
    // マジックリンク（メール確認）は元ジョブで済んでいるため`pending`を経由せず、
    // `queued`で作成して直ちにStep Functionsを起動する。`pendingExpiresAt`は
    // `pending`の間しか意味を持たないためnullにする。
    status: "queued",
    pendingExpiresAt: null,
    outputPath: null,
    outputPath720p: null,
    previewImagePath: null,
    progress: null,
    error: null,
    doneAt: null,
    instanceId: null,
    instanceType: null,
    availabilityZone: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    retriedFromJobId: source.jobId,
    retriedToJobId: null,
  };
}

/**
 * POST /admin/jobs/{jobId}/retry
 * 失敗ジョブの再実行（管理画面。Issue #59）。認可はAPI Gateway側のLambda
 * Authorizerが担う。
 *
 * **同一jobIdでの再実行はしない**。`startPendingJob()`（`jobs.ts`）は「statusが
 * pendingであること」を条件にした原子的更新を前提としており、Step Functionsの実行名も
 * jobIdそのものを使っている（同名の`StartExecution`は`ExecutionAlreadyExists`に
 * なりうる）。既存の冪等性前提を壊さないよう、**新しいjobIdでジョブレコードを複製して
 * 起動する**設計にしている。元ジョブには`retriedToJobId`を記録して相互に辿れるようにする。
 *
 * 完了メール（`sendCompletionEmail.ts`）は新しいジョブが`done`に遷移した時点で
 * 引き継いだ`email`宛に送られ、本文のリンクも新しいjobIdのジョブページになる
 * （ユーザーは古いマジックリンクのままでも新しいメールから辿れる）。
 */
export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const config = loadConfig();
  const sourceJobId = event.pathParameters?.jobId;
  if (!sourceJobId) {
    return error(400, "invalid_request", "jobId が指定されていません");
  }

  const source = await getJob(config.jobsTable, sourceJobId);
  if (!source) {
    return error(404, "not_found", "ジョブが見つかりません");
  }
  // 実行中のジョブを複製すると同一リプレイの録画が二重に走る（＝EC2が二重に課金される）。
  // 先に緊急停止（`POST /admin/jobs/{jobId}/stop`）してから再実行させる。
  if (!isTerminalStatus(source.status)) {
    return error(
      409,
      "job_not_terminal",
      `実行中のジョブは再実行できません（status: ${source.status}）。先に停止してください`,
    );
  }
  // UploadBucketには自動削除ルールが無いため通常は残っているが、手動削除等で
  // 失われていると録画は必ず失敗する。EC2を起動する前に弾く。
  if (!(await objectExists(config.uploadBucket, source.replayKey))) {
    return error(
      409,
      "replay_missing",
      "元のリプレイファイルが見つからないため再実行できません（削除済みの可能性があります）",
    );
  }

  const newJobId = randomUUID();
  const newJob = buildRetryJob(source, newJobId, new Date());
  await putJob(config.jobsTable, newJob);

  try {
    const input: Pick<LaunchTaskEvent, "jobId" | "attempt"> = {
      jobId: newJobId,
      attempt: INITIAL_ATTEMPT,
    };
    await sfn.send(
      new StartExecutionCommand({
        stateMachineArn: required("STATE_MACHINE_ARN"),
        name: newJobId,
        input: JSON.stringify(input),
      }),
    );
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "admin_retry_start_execution_failed",
        sourceJobId,
        jobId: newJobId,
        name: err instanceof Error ? err.name : undefined,
        message: err instanceof Error ? err.message : String(err),
      }),
    );
    // 起動できなかったジョブレコードを`queued`のまま残さない（一覧で永久に
    // 「起動待ち」に見えてしまうため）。
    await updateJobStatus(
      config.jobsTable,
      newJobId,
      "failed",
      "録画ワーカーの起動に失敗しました",
    );
    return error(
      502,
      "launch_failed",
      "録画ワーカーの起動に失敗しました。時間をおいて再試行してください",
    );
  }

  // 元ジョブ→新ジョブのリンクは運用調査用の付加情報に過ぎず、既に起動した実行を
  // 巻き戻す理由にはならないため、失敗してもログのみ残して成功として返す。
  try {
    await updateJobRetryLink(config.jobsTable, sourceJobId, newJobId);
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "admin_retry_link_update_failed",
        sourceJobId,
        jobId: newJobId,
        message: err instanceof Error ? err.message : String(err),
      }),
    );
  }

  console.log(JSON.stringify({ event: "admin_job_retried", sourceJobId, jobId: newJobId }));

  const response: AdminRetryJobResponse = {
    sourceJobId,
    jobId: newJobId,
    status: "queued",
  };
  return json(200, response);
};
