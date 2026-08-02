import { randomUUID } from "node:crypto";
import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import { isTerminalStatus } from "@sattori/shared";
import type { AdminRetryJobResponse, JobRecord } from "@sattori/shared";
import { loadConfig, required } from "../../config.js";
import { objectExistsStrict } from "../../downloads.js";
import { error, json } from "../../http.js";
import {
  claimJobRetryLink,
  getJob,
  JobAlreadyRetriedError,
  putJob,
  releaseJobRetryLink,
  updateJobStatus,
} from "../../jobs.js";
import { INITIAL_ATTEMPT } from "../../retryPolicy.js";
import { buildExecutionArn, getExecutionLiveness } from "../../stepFunctions.js";
import type { ExecutionLiveness } from "../../stepFunctions.js";
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
    outputBytes: null,
    outputBytes720p: null,
    previewImagePath: null,
    progress: null,
    error: null,
    launchedAt: null,
    doneAt: null,
    instanceId: null,
    instanceType: null,
    availabilityZone: null,
    spotPricePerHour: null,
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
 *
 * **二重録画（EC2の二重課金）を防ぐ3段のガード**を持つ:
 * 1. 元ジョブのstatusが終端であること。
 * 2. 元ジョブのStep Functions実行が動いていないこと（statusが`failed`でも
 *    リトライループの最中でありうるため。`stepFunctions.ts`参照）。
 * 3. まだ再実行していないこと（`claimJobRetryLink`による原子的な予約）。
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
  // ただしstatusが終端でも実行が生きていることがある（ワーカーは`SendTaskFailure`より
  // 先に`failed`を書き、ステートマシンはその後も最大10回まで`Launch`をやり直す。
  // `stepFunctions.ts`の`getExecutionLiveness`参照）。上のガードだけでは二重録画を
  // 防げないため、実行の生死も確かめる。判定不能なら安全側（拒否）に倒す
  // ——ここで通してしまうと本当に二重課金が発生するため。
  const executionArn = buildExecutionArn(required("STATE_MACHINE_ARN"), sourceJobId);
  let liveness: ExecutionLiveness;
  try {
    liveness = await getExecutionLiveness(sfn, executionArn);
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "admin_retry_describe_execution_failed",
        sourceJobId,
        executionArn,
        name: err instanceof Error ? err.name : undefined,
        message: err instanceof Error ? err.message : String(err),
      }),
    );
    return error(
      502,
      "execution_check_failed",
      "元ジョブのStep Functions実行状態を確認できなかったため再実行を中止しました（二重録画を避けるため）。時間をおいて再試行してください",
    );
  }
  if (liveness === "running") {
    return error(
      409,
      "source_execution_running",
      "元ジョブのStep Functions実行がまだ動いています（statusはfailedでもリトライ中の可能性があります）。先に緊急停止してください",
    );
  }
  // UploadBucketには自動削除ルールが無いため通常は残っているが、手動削除等で
  // 失われていると録画は必ず失敗する。EC2を起動する前に弾く。「存在しない」を
  // 断定する以上、404以外の失敗を「削除済み」と誤報しないよう厳密版を使う。
  let replayExists: boolean;
  try {
    replayExists = await objectExistsStrict(config.uploadBucket, source.replayKey);
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "admin_retry_head_replay_failed",
        sourceJobId,
        replayKey: source.replayKey,
        name: err instanceof Error ? err.name : undefined,
        message: err instanceof Error ? err.message : String(err),
      }),
    );
    return error(
      502,
      "replay_check_failed",
      "元のリプレイファイルの存在確認に失敗しました（削除されたとは限りません）。時間をおいて再試行してください",
    );
  }
  if (!replayExists) {
    return error(
      409,
      "replay_missing",
      "元のリプレイファイルが見つからないため再実行できません（削除済みの可能性があります）",
    );
  }

  const newJobId = randomUUID();
  // 元ジョブへのリンクを「ジョブを作る前」に原子的に予約することで、二重クリックや
  // リクエストの再送による多重再実行を排他する（フロント側の実行中フラグは
  // 1コンポーネントインスタンスしか守らない）。予約に失敗＝既に再実行済み。
  try {
    await claimJobRetryLink(config.jobsTable, sourceJobId, newJobId);
  } catch (err) {
    if (err instanceof JobAlreadyRetriedError) {
      return error(
        409,
        "job_already_retried",
        `このジョブは既に再実行済みです（再実行先: ${err.retriedToJobId ?? "不明"}）。再度実行したい場合は再実行先のジョブから行ってください`,
      );
    }
    throw err;
  }

  /**
   * 予約（`claimJobRetryLink`）を取り消して、元ジョブを再び再実行可能な状態へ戻す。
   * 起動できなかった予約を残すと、以後の再実行が`job_already_retried`で永久に
   * 弾かれてしまうため。取り消し自体の失敗はログのみ（呼び出し側は既に別のエラーを
   * 返そうとしている）。
   */
  const rollbackClaim = async () => {
    try {
      await releaseJobRetryLink(config.jobsTable, sourceJobId, newJobId);
    } catch (err) {
      console.error(
        JSON.stringify({
          event: "admin_retry_link_release_failed",
          sourceJobId,
          jobId: newJobId,
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  };

  const newJob = buildRetryJob(source, newJobId, new Date());
  try {
    await putJob(config.jobsTable, newJob);
  } catch (err) {
    await rollbackClaim();
    throw err;
  }

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
    await rollbackClaim();
    return error(
      502,
      "launch_failed",
      "録画ワーカーの起動に失敗しました。時間をおいて再試行してください",
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
