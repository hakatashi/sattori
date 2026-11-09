import {
  isGpuStep,
  recordingSpeedForStep,
  remainingRecordingSteps,
  vcpusForInstanceType,
} from "@sattori/shared";
import type { Ec2RecordingStep, JobRecord, RecordingStep, WorkerHeartbeat } from "@sattori/shared";
import { loadConfig } from "../../config.js";
import type { ApiConfig } from "../../config.js";
import {
  FleetLaunchError,
  launchRecordingInstance,
  launchTierFor,
  SPOT_CAPACITY_ERROR_CODES,
} from "../../ec2.js";
import { getGpuLease, releaseGpuSlot, shrinkGpuLease } from "../../gpuSlots.js";
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
  setRecordingStep,
  updateCapacityExhaustedTargets,
  updateJobInstance,
  updateJobStatus,
  updateJobWorkerKind,
} from "../../jobs.js";
import { loadRecordingStepFilter } from "../../recordingSteps.js";
import { CAPACITY_EXHAUSTED_MESSAGE } from "../../retryPolicy.js";
import { buildWorkerEnv } from "../../workerEnv.js";
import { HOME_WORKER_ROUTING_POLICY, selectHomeWorker } from "../../workerRouting.js";

/**
 * Step Functions の `Launch` ステート（`waitForTaskToken` パターン）から呼ばれる Lambda。
 * ワーカーを1台「割り当てる」だけで、成功/失敗の確定はワーカー自身が `taskToken` 経由で
 * `SendTaskSuccess`/`SendTaskFailure` を呼ぶことで行う（このハンドラの戻り値は
 * Step Functions の実行結果に影響しない）。割り当て自体が失敗した場合は例外を投げ、
 * ステートマシンの Catch に委ねる。
 *
 * **割り当て先はタイトルごとの録画の段（`recordingPlan.ts`、Issue #317）を先頭から順に試して
 * 決める**。段は2種類ある:
 *
 * 1. **自宅ワーカー**（Issue #49）: `WorkersTable` に新鮮なハートビートを出している常駐
 *    デーモンがいて、そのジョブを引き受けられる状態なら、ジョブレコードへオファーを書いて
 *    数十秒だけclaimを待つ。claimされたらこのハンドラの仕事は終わり（以降はデーモンが
 *    taskToken を持つ）。いなければ・claimされなければ次の段へ。
 * 2. **EC2 Fleet**: Spotインスタンスを1台起動する。段の全サブネット・全候補がSpot在庫の枯渇で
 *    失敗したら、その段を`capacityExhaustedTargets`へ記録して同じ呼び出しの中で次の段へ進む
 *    （Issue #315、`docs/decisions/0063`）。ステートマシンへ戻すと`WaitBeforeCheck`の3分を
 *    待つことになるため。
 *
 * 段ごとに、その段の録画速度を`options.recordingSpeed`へ書いてからワーカーの環境変数を作る。
 * 全段を使い切ったら、待っても在庫が戻る見込みが無いのでその場でジョブを失敗させる。
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

  await assignWorker(config, job, event);
};

/** 段を先頭から試し、ワーカーを1台割り当てる。 */
async function assignWorker(
  config: ApiConfig,
  job: JobRecord,
  event: LaunchTaskEvent,
): Promise<void> {
  const excluded = await loadRecordingStepFilter(config, event.jobId);
  const exhausted = [...(job.capacityExhaustedTargets ?? [])];
  const failures: FleetLaunchError[] = [];
  // 試した段のうち、Spot在庫の枯渇以外の理由（一部のサブネットのクォータ超過など）で
  // 起動できなかった段があるか。あればリトライの余地があるので、失敗させずに例外を投げる。
  let retryable = false;
  // この呼び出しでGPUの段を試したか。GPUの段はGPU以外の段より前にある（`recordingPlan.ts`）ので、
  // 試した後でGPU以外の段へ進むならリースはもう要らない。
  let triedGpu = false;

  const steps = remainingRecordingSteps(job, excluded);
  console.log(
    JSON.stringify({ event: "launch_steps", jobId: job.jobId, steps: steps.map((step) => step.id), exhausted }),
  );
  for (const step of steps) {
    if (isGpuStep(step)) {
      triedGpu = true;
    } else if (triedGpu) {
      triedGpu = false;
      await releaseGpuLease(config, event.jobId);
    }

    if (step.kind === "home") {
      if (await tryOfferToHomeWorker(config, job, step, event)) {
        return;
      }
      continue;
    }

    try {
      if (await launchOnEc2(config, job, event, step)) {
        return;
      }
    } catch (err) {
      if (
        !(err instanceof FleetLaunchError) ||
        !err.errorCodes.some((code) => SPOT_CAPACITY_ERROR_CODES.includes(code))
      ) {
        // クォータ超過・API障害など、次の段へ逃がしても解消しない失敗。前の段の失敗も
        // メッセージへ残す（`handleFailure.ts`の容量不足判定は部分一致）。
        throw failures.length === 0 ? err : combineLaunchFailures(failures, err);
      }
      failures.push(err);
      if (err.capacityExhausted) {
        exhausted.push(step.id);
        await recordExhaustedSteps(config, event.jobId, exhausted);
      } else {
        retryable = true;
      }
      console.warn(
        JSON.stringify({
          event: "launch_step_failed",
          jobId: job.jobId,
          stepId: step.id,
          capacityExhausted: err.capacityExhausted,
          errorCodes: err.errorCodes,
        }),
      );
    }
  }

  if (retryable) {
    throw combineLaunchFailures(failures);
  }
  // 全段が前の試行で記録済みで、今回は1回もCreateFleetしていないこともある。
  const message =
    failures.map((failure) => failure.message).join(" / ") ||
    `全段を使い切りました: ${exhausted.join(", ")}`;
  await failForCapacity(
    config,
    event,
    new FleetLaunchError(message, failures.flatMap((failure) => failure.errorCodes), true),
  );
}

/**
 * 段の`id`と録画速度をジョブレコードへ書き、それを反映したジョブを返す（以降の環境変数・
 * 推定はこの値から作る）。緊急停止などで書けなければ例外を投げて割り当てを止める
 * （判断は`HandleFailure`に任せる）。
 */
async function enterStep(config: ApiConfig, job: JobRecord, step: RecordingStep): Promise<JobRecord> {
  const recordingSpeed = recordingSpeedForStep(step, job);
  const written = await setRecordingStep(config.jobsTable, job.jobId, step.id, recordingSpeed);
  if (!written) {
    throw new Error(`ジョブ ${job.jobId} は停止済みか完了済みのため、段 ${step.id} を割り当てません`);
  }
  console.log(
    JSON.stringify({ event: "launch_step", jobId: job.jobId, stepId: step.id, recordingSpeed }),
  );
  return { ...job, recordingStepId: step.id, options: { ...job.options, recordingSpeed } };
}

/** 複数の段の失敗を1つの例外にまとめる。 */
function combineLaunchFailures(failures: FleetLaunchError[], last?: unknown): FleetLaunchError {
  const lastMessage = last === undefined ? [] : [last instanceof Error ? last.message : String(last)];
  return new FleetLaunchError(
    [...failures.map((failure) => failure.message), ...lastMessage].join(" / "),
    [
      ...failures.flatMap((failure) => failure.errorCodes),
      ...(last instanceof FleetLaunchError ? last.errorCodes : []),
    ],
  );
}

/**
 * 全段を使い切ったジョブを失敗させ、ステートマシンのCatchへ渡すために例外を投げる。
 * Catchの先の`HandleFailure`は後始末だけしてリトライしない（`failedByLaunch`）。
 */
async function failForCapacity(
  config: ApiConfig,
  event: LaunchTaskEvent,
  exhausted: FleetLaunchError,
): Promise<never> {
  await releaseGpuLease(config, event.jobId);
  await updateJobStatus(config.jobsTable, event.jobId, "failed", CAPACITY_EXHAUSTED_MESSAGE, {
    unlessDone: true,
    errorCode: "capacity_exhausted",
  });
  throw exhausted;
}

/**
 * GPUの段を離れるジョブのリースを返却する。失敗しても録画は止めない
 * （`HandleFailure`と同じく、取りこぼしはリコンサイラが期限切れで回収する）。
 */
async function releaseGpuLease(config: ApiConfig, jobId: string): Promise<void> {
  try {
    await releaseGpuSlot(config.gpuSlotsTable, jobId);
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "release_gpu_slot_failed",
        jobId,
        message: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

/** 使い切った段の記録。失敗してもリトライで同じ段をもう一度試すだけなので起動は続ける。 */
async function recordExhaustedSteps(
  config: ApiConfig,
  jobId: string,
  stepIds: string[],
): Promise<void> {
  try {
    await updateCapacityExhaustedTargets(config.jobsTable, jobId, stepIds);
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "capacity_exhausted_targets_write_failed",
        jobId,
        message: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

/**
 * EC2の段を1台起動する。起動できたら true。段のリージョンを解決できない（フォールバック先が
 * 未設定の環境）なら false を返し、呼び出し側は次の段へ進む。
 */
async function launchOnEc2(
  config: ApiConfig,
  job: JobRecord,
  event: LaunchTaskEvent,
  step: Ec2RecordingStep,
): Promise<boolean> {
  const isGpuJob = step.platform === "gpu";
  let maxVcpu: number | undefined;
  if (isGpuJob) {
    // GPU vCPU容量リース（Issue #270）。`AcquireGpuSlot`ステートが既に確保済みの
    // はずだが、SFnのペイロードには乗せず自分のjobIdで読み直す（デプロイ中の
    // 飛行中の実行との互換性・「リースが実在すること」の直前再確認を兼ねる。
    // 詳細は `docs/decisions/0056-gpu-vcpu-lease-and-queue.md`）。
    const lease = await getGpuLease(config.gpuSlotsTable, event.jobId);
    if (!lease) {
      throw new Error(`GPUジョブ ${event.jobId} のvCPUリースが見つかりません`);
    }
    maxVcpu = lease.vcpu;
  }

  const tier = launchTierFor(config, step, { maxVcpu });
  if (tier === null) {
    console.warn(
      JSON.stringify({ event: "launch_step_unresolvable", jobId: job.jobId, stepId: step.id, region: step.region }),
    );
    return false;
  }
  const stepJob = await enterStep(config, job, step);
  const instance = await launchRecordingInstance(config, stepJob, event.taskToken, tier);
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

  // 実際に確保できたインスタンスタイプに合わせてリースを縮小する（例:
  // 8vCPU仮予約→g6f.xlargeが取れたので4へ）。これにより残ったvCPUで別のジョブが
  // 並列に走れる（ADR 0046「2台分の並列運用余地」）。縮小の失敗はジョブを
  // 落とす理由にならない（`shrinkGpuLease`内でログのみに残し、リコンサイラが補正する）。
  if (isGpuJob && maxVcpu !== undefined && instance.instanceType) {
    const actualVcpu = vcpusForInstanceType(instance.instanceType);
    if (actualVcpu !== null) {
      await shrinkGpuLease(
        config.gpuSlotsTable,
        event.jobId,
        maxVcpu,
        actualVcpu,
        instance.instanceType,
        instance.instanceId,
      );
    }
  }
  return true;
}

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
  step: RecordingStep,
  event: LaunchTaskEvent,
): Promise<boolean> {
  const policy = HOME_WORKER_ROUTING_POLICY;

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
  // オファーする相手がいるときだけ段を書く（自宅ワーカーが動いていない平常時に書き込みを増やさない）。
  const stepJob = await enterStep(config, job, step);

  const expiresAt = new Date(Date.now() + policy.offerWindowSeconds * 1000).toISOString();
  // Spot中断監視（Issue #96）は自宅マシンにIMDSが存在しないため無効にする
  // （有効にすると`interruption_watcher.py`が7秒周期でタイムアウトし続ける）。
  const env = buildWorkerEnv(config, stepJob, event.taskToken, {
    spotInterruptionWatch: false,
    dataRegion: config.ec2.region,
    gpuWorker: false,
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
