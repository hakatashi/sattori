import {
  isHeartbeatFresh,
  LAUNCH_LAMBDA_TIMEOUT_SECONDS,
  requiresGpuRecording,
} from "@sattori/shared";
import type { JobRecord, WorkerHeartbeat } from "@sattori/shared";

/**
 * 「このジョブを誰に任せるか」の方針（Issue #49）。GPUが必須のジョブ
 * （`requiresGpuRecording()`）は自宅ワーカーへオファーせず常にEC2（GPU系）へ、
 * それ以外は自宅ワーカーが空いていれば自宅、いなければEC2へ振り分ける。
 */
export interface GameRoutingPolicy {
  /**
   * 自宅ワーカーへオファーするか。false なら常にEC2 Fleetを起動する
   * （自宅マシンでは録画できないタイトルが出てきた場合の逃げ道）。
   */
  offerToHomeWorker: boolean;
  /**
   * オファーを出してからclaimを待つ秒数。これを過ぎたらオファーを撤回して
   * EC2 Fleetへフォールバックする。
   *
   * 待ち時間はそのまま録画開始の遅延になるが、**ハートビートが新鮮なワーカーが
   * いる場合しかオファーしない**ので、平常時（自宅サーバーが落ちている）に
   * この待ちが発生することはない。デーモンのポーリング間隔
   * （`home-worker/`の`HOME_WORKER_POLL_INTERVAL_SEC`、既定3秒）の数倍を確保する。
   *
   * **`MAX_OFFER_WINDOW_SECONDS` を超えないこと**（テストで守っている）。この待機は
   * `Launch` Lambdaの実行時間をそのまま消費するため、伸ばしすぎると関数タイムアウトに
   * ぶつかる。
   */
  offerWindowSeconds: number;
}

/**
 * `Launch` Lambdaのタイムアウトのうち、オファー待機以外の処理に残しておく秒数。
 * 待機の前後には、ハートビートのScan・オファーの書き込み・撤回、そしてEC2 Fleetの
 * 起動一式（`CreateLaunchTemplateVersion` → `CreateFleet` →
 * `DescribeSpotPriceHistory` → ジョブレコード更新）が並ぶ。
 */
export const LAUNCH_OVERHEAD_RESERVE_SECONDS = 20;

/**
 * `offerWindowSeconds` に指定してよい上限。
 *
 * これを超えると、オファーを撤回した直後（あるいは撤回すらできないまま）に`Launch`が
 * タイムアウトし、**オファーは消えたのにEC2も起動していない**状態で15分の
 * ハートビートタイムアウトを待つ、丸ごと無駄なリトライが1周発生する。待機を伸ばしたくなったときは、この上限——
 * すなわち`LAUNCH_LAMBDA_TIMEOUT_SECONDS`（CDKが使う定数）——も併せて引き上げること。
 */
export const MAX_OFFER_WINDOW_SECONDS =
  LAUNCH_LAMBDA_TIMEOUT_SECONDS - LAUNCH_OVERHEAD_RESERVE_SECONDS;

/** タイトル固有の指定が無い場合の方針。 */
export const DEFAULT_ROUTING_POLICY: GameRoutingPolicy = {
  offerToHomeWorker: true,
  offerWindowSeconds: 20,
};

/** GPU必須のジョブ（`requiresGpuRecording()`）に適用する方針。自宅ワーカーへはオファーしない。 */
export const GPU_ONLY_ROUTING_POLICY: GameRoutingPolicy = {
  offerToHomeWorker: false,
  offerWindowSeconds: 0,
};

/** ジョブに適用する方針を決める。 */
export function routingPolicyFor(job: Pick<JobRecord, "game" | "options">): GameRoutingPolicy {
  // GPU必須のジョブ（th06nc・th15・th20と倍速録画）。自宅ワーカーはGPUを搭載していない
  // ため、常にEC2（GPU系）へ固定する（`docs/decisions/0047-no-gpu-titles-for-home-worker.md`）。
  return requiresGpuRecording(job) ? GPU_ONLY_ROUTING_POLICY : DEFAULT_ROUTING_POLICY;
}

/** そのワーカーがこのジョブを引き受けられる状態か。 */
export function isWorkerEligible(
  worker: WorkerHeartbeat,
  job: Pick<JobRecord, "game">,
  policy: GameRoutingPolicy,
  now: Date,
): boolean {
  if (!isHeartbeatFresh(worker, now)) {
    return false;
  }
  if (!worker.accepting) {
    return false;
  }
  if (worker.activeJobs >= worker.maxConcurrency) {
    return false;
  }
  return worker.supportedGames.includes(job.game);
}

/**
 * オファー先の自宅ワーカーを1台選ぶ。該当が無ければ null（＝即EC2起動）。
 *
 * 現状の自宅ワーカーは1台だけの想定だが、複数台になった場合に備えて
 * **空きスロットが多い順**に選ぶ（同数なら`workerId`で安定させる）。オファー自体は
 * 特定のワーカーを名指ししない（claimは早い者勝ちの条件付き更新）ので、ここでの
 * 選択は「オファーを出す価値があるか」の判定と、ログに残す代表ワーカーの決定に使う。
 */
export function selectHomeWorker(
  workers: WorkerHeartbeat[],
  job: Pick<JobRecord, "game">,
  policy: GameRoutingPolicy,
  now: Date,
): WorkerHeartbeat | null {
  if (!policy.offerToHomeWorker) {
    return null;
  }
  const eligible = workers.filter((worker) => isWorkerEligible(worker, job, policy, now));
  if (eligible.length === 0) {
    return null;
  }
  return eligible.reduce((best, worker) => {
    const bestSlots = best.maxConcurrency - best.activeJobs;
    const slots = worker.maxConcurrency - worker.activeJobs;
    if (slots !== bestSlots) {
      return slots > bestSlots ? worker : best;
    }
    return worker.workerId < best.workerId ? worker : best;
  });
}
