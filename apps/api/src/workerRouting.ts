import { isHeartbeatFresh } from "@sattori/shared";
import type { GameId, JobRecord, WorkerCapability, WorkerHeartbeat } from "@sattori/shared";

/**
 * 「このジョブを誰に任せるか」の方針（Issue #49）。タイトルごとに変えられるように
 * してあるのは、th20（東方錦上京、Issue #87）で自宅ワーカーとEC2の使い分けが
 * 明確に非対称になる見込みがあるため。
 *
 * th20は描画負荷が高く、原則として4xlarge級のインスタンスが要る。さらに録画品質を
 * 担保するため 1/2 倍速で録画して後処理で等速へ戻す方式（Issue #68）を採りたいが、
 * 録画に倍の実時間がかかるためEC2では割に合わない。したがって
 * **「低速録画できる自宅ワーカーが空いていれば自宅で低速録画、いなければ4xlarge級の
 * EC2で等速録画」**という振り分けになる。これは
 *
 *   - `requiredCapabilities: ["slow-motion-recording"]` … 能力を持つワーカーにだけ
 *     オファーする
 *   - `offerWindowSeconds` … 自宅ワーカーを待つ価値が高いので既定より長くする
 *   - EC2側の候補インスタンスタイプ（`ec2.ts` の `getCandidateInstanceTypes`）を
 *     th20だけ4xlarge級にする
 *
 * の3点で表現できる。**その時が来たら `GAME_ROUTING_POLICIES` にth20の行を足す**のが
 * 想定手順で、ルーティングの判定ロジック自体は変更しなくてよい設計にしてある。
 */
export interface GameRoutingPolicy {
  /**
   * 自宅ワーカーへオファーするか。false なら常にEC2 Fleetを起動する
   * （自宅マシンでは録画できないタイトルが出てきた場合の逃げ道）。
   */
  offerToHomeWorker: boolean;
  /**
   * オファー先に要求する追加能力。1つでも欠けるワーカーにはオファーしない。
   * 空配列なら「普通に録画できれば誰でもよい」。
   */
  requiredCapabilities: WorkerCapability[];
  /**
   * オファーを出してからclaimを待つ秒数。これを過ぎたらオファーを撤回して
   * EC2 Fleetへフォールバックする。
   *
   * 待ち時間はそのまま録画開始の遅延になるが、**ハートビートが新鮮なワーカーが
   * いる場合しかオファーしない**ので、平常時（自宅サーバーが落ちている）に
   * この待ちが発生することはない。デーモンのポーリング間隔
   * （`home-worker/`の`HOME_WORKER_POLL_INTERVAL_SEC`、既定3秒）の数倍を確保する。
   */
  offerWindowSeconds: number;
}

/** タイトル固有の指定が無い場合の方針。 */
export const DEFAULT_ROUTING_POLICY: GameRoutingPolicy = {
  offerToHomeWorker: true,
  requiredCapabilities: [],
  offerWindowSeconds: 20,
};

/**
 * タイトルごとの上書き。現在は全タイトルが既定の方針で足りるため空
 * （th20を追加する際の想定は上の `GameRoutingPolicy` のコメント参照）。
 */
export const GAME_ROUTING_POLICIES: Partial<Record<GameId, GameRoutingPolicy>> = {};

export function routingPolicyFor(game: GameId): GameRoutingPolicy {
  return GAME_ROUTING_POLICIES[game] ?? DEFAULT_ROUTING_POLICY;
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
  if (!worker.supportedGames.includes(job.game)) {
    return false;
  }
  return policy.requiredCapabilities.every((capability) =>
    worker.capabilities.includes(capability),
  );
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
