import type { JobRecord, WorkerHeartbeat } from "@sattori/shared";
import { loadConfig } from "../../config.js";
import type { ApiConfig } from "../../config.js";
import { launchRecordingInstance } from "../../ec2.js";
import {
  getHomeWorkerAssignment,
  listWorkerHeartbeats,
  offerJobToHomeWorker,
  releaseHomeWorkerAssignment,
  waitForHomeWorkerClaim,
  withdrawHomeWorkerOffer,
} from "../../homeWorker.js";
import {
  getJob,
  markJobLaunched,
  updateJobInstance,
  updateJobStatus,
  updateJobWorkerKind,
} from "../../jobs.js";
import { buildWorkerEnv } from "../../workerEnv.js";
import { routingPolicyFor, selectHomeWorker } from "../../workerRouting.js";

/**
 * Step Functions の `Launch` ステート（`waitForTaskToken` パターン）から呼ばれる Lambda。
 * ワーカーを1台「割り当てる」だけで、成功/失敗の確定はワーカー自身が `taskToken` 経由で
 * `SendTaskSuccess`/`SendTaskFailure` を呼ぶことで行う（このハンドラの戻り値は
 * Step Functions の実行結果に影響しない）。割り当て自体が失敗した場合は例外を投げ、
 * ステートマシンの Catch に委ねる。
 *
 * 割り当て先は2種類ある（Issue #49）:
 *
 * 1. **自宅ワーカー**: `WorkersTable` に新鮮なハートビートを出している常駐デーモンが
 *    いて、そのジョブを引き受けられる状態なら、ジョブレコードへオファーを書いて
 *    数十秒だけclaimを待つ。claimされたらこのハンドラの仕事は終わり（以降は
 *    デーモンが taskToken を持つ）。
 * 2. **EC2 Fleet**: オファーしなかった／時間内にclaimされなかった場合、従来どおり
 *    Spotインスタンスを1台起動する。
 *
 * 自宅ワーカーがいない平常時はハートビートの読み取り1回ぶんしか増えず、待機も
 * 発生しない（＝録画開始が遅くならない）。
 */
export interface LaunchTaskEvent {
  jobId: string;
  /** 何回目の起動試行か（1始まり）。ログ・診断用。 */
  attempt: number;
  /** Step Functions が発行した `waitForTaskToken` のトークン。 */
  taskToken: string;
}

/** オファーがclaimされたかを確認する間隔（ミリ秒）。 */
const CLAIM_POLL_INTERVAL_MS = 2000;

export const handler = async (event: LaunchTaskEvent): Promise<void> => {
  const config = loadConfig();
  const job = await getJob(config.jobsTable, event.jobId);
  if (!job) {
    throw new Error(`ジョブが見つかりません: ${event.jobId}`);
  }

  console.log(
    JSON.stringify({ event: "launch_attempt", jobId: event.jobId, attempt: event.attempt }),
  );

  if (await tryOfferToHomeWorker(config, job, event)) {
    return;
  }

  const instance = await launchRecordingInstance(config, job, event.taskToken);
  // **`instanceId` の永続化を他の更新より先に行う**（Issue #23）。`CreateFleet` が
  // 返った時点で課金は始まっており、ここでLambdaがタイムアウトすると誰も
  // terminateできない孤児が残る。この窓は原理的には消せない（起動と記録は
  // 別ステップにならざるを得ない）が、DynamoDBへの書き込み3回ぶんから1回ぶんへ
  // 縮めることはできる。窓に落ちたインスタンスの回収はタグ経由の後始末
  // （`handleFailure.ts`）と定期掃除（`handlers/sweepOrphanInstances.ts`）が担う。
  await updateJobInstance(config.jobsTable, event.jobId, instance);
  await updateJobStatus(config.jobsTable, event.jobId, "launching");
  await updateJobWorkerKind(config.jobsTable, event.jobId, "ec2");
  // コスト推定の課金起点（Issue #60）。リトライで再入しても最初の1回しか記録されない。
  await markJobLaunched(config.jobsTable, event.jobId);
};

/**
 * 自宅ワーカーへのオファーを試みる。claimされた（＝このジョブの面倒はデーモンが見る）
 * なら true を返し、呼び出し側はEC2を起動しない。
 *
 * ハートビートの読み取りやオファーの書き込みで想定外の例外が出た場合は、**握りつぶして
 * EC2起動へフォールバックする**。自宅ワーカーはあくまでコスト削減のための best-effort な
 * 経路であり、その不調でユーザーの録画そのものを落としてはならない。ただし
 * 「オファーを撤回できなかった（＝誰かがclaimした）」だけは握りつぶさずEC2起動を
 * 中止する。ここを踏み外すと同じリプレイを2台で録画してしまうため。
 *
 * 逆に「オファーを書けなかった」は claim済みとは限らない（`handleOfferConflict()`
 * 参照）。誤ってclaim済みと読むと、今回のtaskTokenを誰も持たないまま15分の
 * タイムアウトを待つことになる。
 */
async function tryOfferToHomeWorker(
  config: ApiConfig,
  job: JobRecord,
  event: LaunchTaskEvent,
): Promise<boolean> {
  const policy = routingPolicyFor(job);
  if (!policy.offerToHomeWorker) {
    return false;
  }

  let worker: WorkerHeartbeat | null = null;
  try {
    const workers = await listWorkerHeartbeats(config.workersTable);
    worker = selectHomeWorker(workers, job, policy, new Date());
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "home_worker_lookup_failed",
        jobId: event.jobId,
        message: err instanceof Error ? err.message : String(err),
      }),
    );
    return false;
  }
  if (worker === null) {
    return false;
  }

  const expiresAt = new Date(Date.now() + policy.offerWindowSeconds * 1000).toISOString();
  // 低速録画（Issue #68）が有効になるのはこの経路だけ。EC2 Fleet 起動時
  // （`ec2.buildUserData`）は常に等倍で、そちらがフォールバック先になる。
  const env = buildWorkerEnv(config, job, event.taskToken, {
    slowMotion: job.options.slowMotion,
  });
  try {
    const offered = await offerJobToHomeWorker({
      jobsTable: config.jobsTable,
      jobId: event.jobId,
      env,
      expiresAt,
    });
    if (!offered) {
      return await handleOfferConflict(config, event);
    }
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "home_worker_offer_failed",
        jobId: event.jobId,
        message: err instanceof Error ? err.message : String(err),
      }),
    );
    return false;
  }

  console.log(
    JSON.stringify({
      event: "home_worker_offered",
      jobId: event.jobId,
      attempt: event.attempt,
      workerId: worker.workerId,
      offerWindowSeconds: policy.offerWindowSeconds,
    }),
  );

  const assignedWorkerId = await waitForHomeWorkerClaim({
    jobsTable: config.jobsTable,
    jobId: event.jobId,
    deadline: Date.parse(expiresAt),
    intervalMs: CLAIM_POLL_INTERVAL_MS,
  });

  if (assignedWorkerId !== null) {
    // `launching` への遷移はclaimと同じ条件付き更新の中でデーモンが済ませている
    // （後からここで書くと、先に走り出したコンテナの`recording`を上書きしうる）。
    console.log(
      JSON.stringify({
        event: "home_worker_claimed",
        jobId: event.jobId,
        attempt: event.attempt,
        workerId: assignedWorkerId,
      }),
    );
    return true;
  }

  const withdrawn = await withdrawHomeWorkerOffer(config.jobsTable, event.jobId);
  if (!withdrawn) {
    // 撤回の直前にclaimされた。EC2を起動すると二重録画になるので何もしない。
    console.log(
      JSON.stringify({ event: "home_worker_claimed_at_withdrawal", jobId: event.jobId }),
    );
    return true;
  }

  console.log(
    JSON.stringify({
      event: "home_worker_offer_withdrawn",
      jobId: event.jobId,
      attempt: event.attempt,
    }),
  );
  return false;
}

/**
 * オファーの条件チェックが失敗した（＝既に `assignedWorkerId` がある）ときの分岐。
 * true を返すとEC2を起動しない。
 *
 * 「既に誰かがclaim済み」と決めつけてはいけない。`HandleFailure` の
 * `releaseHomeWorkerAssignment` は失敗をログだけにして `shouldRetry` を返すため、
 * **前の試行の割り当てが解除されずに残ったまま再入する**ことがある。それをclaim済みと
 * 誤読すると、今回の taskToken を誰も持たないまま15分のハートビートタイムアウトを
 * 待つことになり、リトライ1周（待機3分を含め約18分）が丸ごと無駄になる。
 *
 * 見分け方は `getHomeWorkerAssignment()` のコメント参照（レコードに載っている
 * taskToken が今回のものかどうか）。陳腐化していた場合は割り当てを解除してEC2へ
 * フォールバックする。解除は走っている古いコンテナを止める手段も兼ねる
 * （デーモンは `assignedWorkerId` が自分でなくなった時点で `docker kill` する）。
 */
async function handleOfferConflict(
  config: ApiConfig,
  event: LaunchTaskEvent,
): Promise<boolean> {
  let assignment: { assignedWorkerId: string | null; taskToken: string | null };
  try {
    assignment = await getHomeWorkerAssignment(config.jobsTable, event.jobId);
  } catch (err) {
    // 判別できないなら安全側（EC2を起動しない）に倒す。二重録画のほうが害が大きい。
    console.warn(
      JSON.stringify({
        event: "home_worker_assignment_lookup_failed",
        jobId: event.jobId,
        attempt: event.attempt,
        message: err instanceof Error ? err.message : String(err),
      }),
    );
    return true;
  }

  if (assignment.taskToken === event.taskToken) {
    // 今回のトークンを持つワーカーが走っている（Launchの再入）。EC2は起動しない。
    console.log(
      JSON.stringify({
        event: "home_worker_offer_skipped",
        jobId: event.jobId,
        attempt: event.attempt,
        workerId: assignment.assignedWorkerId,
      }),
    );
    return true;
  }

  console.warn(
    JSON.stringify({
      event: "home_worker_stale_assignment",
      jobId: event.jobId,
      attempt: event.attempt,
      workerId: assignment.assignedWorkerId,
    }),
  );
  try {
    await releaseHomeWorkerAssignment(config.jobsTable, event.jobId);
  } catch (err) {
    // 解除できなくてもEC2は起動する。今回の試行にはワーカーが1台も居らず、
    // 放置すればタイムアウトが確定するため（古いコンテナが完走した場合は
    // そちらの結果がジョブレコードに残るが、トークンが死んでいるので
    // ステートマシンへは通知されない）。
    console.error(
      JSON.stringify({
        event: "home_worker_stale_release_failed",
        jobId: event.jobId,
        attempt: event.attempt,
        message: err instanceof Error ? err.message : String(err),
      }),
    );
  }
  return false;
}
