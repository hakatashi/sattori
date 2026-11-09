import { isHeartbeatFresh, LAUNCH_LAMBDA_TIMEOUT_SECONDS } from "@sattori/shared";
import type { JobRecord, WorkerHeartbeat } from "@sattori/shared";

/**
 * 自宅ワーカーへのオファーの方針（Issue #49）。オファーするかどうかは録画の段が決める
 * （`recordingPlan.ts`の`kind: "home"`の段だけがオファーする）。
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
 * `DescribeSpotPriceHistory` → ジョブレコード更新）が並ぶ。倍速録画がGPUの段を使い切って
 * 等倍へ落ちる経路（Issue #315）では、その手前にGPUの段の試行（1段あたり`CreateFleet`約2秒）と
 * フォールバックの書き込みも入る。2段+CPUの起動で十数秒に収まる見込み。
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

/** 自宅ワーカーの段（`kind: "home"`）でオファーするときの方針。 */
export const HOME_WORKER_ROUTING_POLICY: GameRoutingPolicy = {
  offerToHomeWorker: true,
  offerWindowSeconds: 20,
};

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
