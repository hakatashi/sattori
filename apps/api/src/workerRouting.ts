import {
  isHeartbeatFresh,
  LAUNCH_LAMBDA_TIMEOUT_SECONDS,
  SLOW_MOTION_CAPABILITY,
} from "@sattori/shared";
import type { GameId, JobRecord, WorkerCapability, WorkerHeartbeat } from "@sattori/shared";

/**
 * 「このジョブを誰に任せるか」の方針（Issue #49）。タイトルごとに変えられるように
 * してあるのは、th20（東方錦上京、Issue #87）で自宅ワーカーとEC2の使い分けが
 * 明確に非対称になるため。
 *
 * th20は描画負荷が高く、原則として4xlarge級のインスタンスが要る（`ec2.ts` の
 * `TH20_CANDIDATE_INSTANCE_TYPES`）。さらに録画品質を担保するため 1/2 倍速で録画して
 * 後処理で等速へ戻す方式（Issue #68）を採るが、録画に倍の実時間がかかるためEC2では
 * 割に合わない。したがって **「低速録画できる自宅ワーカーが空いていれば自宅で低速録画、
 * いなければ4xlarge級のEC2で等速録画」** という振り分けになる。
 *
 * 低速録画の要求（`slow-motion-recording` 能力）は**タイトルではなくジョブの
 * オプション**に紐づく（`routingPolicyFor()` が `options.slowMotion` から足す）。
 * th20でもユーザーが低速録画を外していれば、その能力を持たない自宅ワーカーへ
 * オファーして構わない——EC2を1台起こさずに済むこと自体に価値があるため、
 * 不要な条件でオファー先を狭めない。`GAME_ROUTING_POLICIES` の行が受け持つのは
 * 「自宅ワーカーを待つ価値がどれだけあるか」（`offerWindowSeconds`）だけである。
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
 * ハートビートタイムアウトを待つ、丸ごと無駄なリトライが1周発生する。th20（Issue #87）
 * のように待機を伸ばしたくなったときは、この上限——すなわち
 * `LAUNCH_LAMBDA_TIMEOUT_SECONDS`（CDKが使う定数）——も併せて引き上げること。
 */
export const MAX_OFFER_WINDOW_SECONDS =
  LAUNCH_LAMBDA_TIMEOUT_SECONDS - LAUNCH_OVERHEAD_RESERVE_SECONDS;

/** タイトル固有の指定が無い場合の方針。 */
export const DEFAULT_ROUTING_POLICY: GameRoutingPolicy = {
  offerToHomeWorker: true,
  requiredCapabilities: [],
  offerWindowSeconds: 20,
};

/**
 * タイトルごとの上書き。
 *
 * th20（Issue #87）だけオファー待ちを上限いっぱいまで延ばしている。他タイトルでは
 * 「自宅が空いていなければEC2で同じ品質の録画ができる」ので待つ価値が薄いが、th20は
 *
 *   - EC2のフォールバック先が`.4xlarge`帯（他タイトルの`.xlarge`帯の約4倍の単価）
 *   - 自宅ワーカーでしか低速録画（Issue #68）ができず、等倍録画では高負荷区間の
 *     処理落ちを避けられない（touhou-recorder reports/46）
 *
 * の2点で、数十秒の録画開始遅延を払ってでも自宅ワーカーを待つ価値が明確に高い。
 * ハートビートが新鮮なワーカーがいる場合しかオファーしないので、自宅サーバーが
 * 落ちている平常時にこの待ちが発生することはない。
 */
export const GAME_ROUTING_POLICIES: Partial<Record<GameId, GameRoutingPolicy>> = {
  th20: {
    offerToHomeWorker: true,
    requiredCapabilities: [],
    offerWindowSeconds: MAX_OFFER_WINDOW_SECONDS,
  },
};

/**
 * ジョブに適用する方針を決める。タイトル固有の行（`GAME_ROUTING_POLICIES`）に、
 * ジョブのオプション由来の要求能力を重ねる。
 *
 * 低速録画（Issue #68）を希望するジョブは `slow-motion-recording` を宣言している
 * ワーカーにしかオファーしない。宣言していないワーカーがclaimすると、
 * `FPS_LIMIT_TARGET_HZ` 付きの環境変数を渡したまま低速録画に対応しない挙動を
 * されるおそれがあるため（実際には同一イメージなので動くが、能力宣言を唯一の
 * 契約として扱い、ワーカー側の実装差を許容できるようにしておく）。
 */
export function routingPolicyFor(job: Pick<JobRecord, "game" | "options">): GameRoutingPolicy {
  const base = GAME_ROUTING_POLICIES[job.game] ?? DEFAULT_ROUTING_POLICY;
  if (!job.options.slowMotion || base.requiredCapabilities.includes(SLOW_MOTION_CAPABILITY)) {
    return base;
  }
  return {
    ...base,
    requiredCapabilities: [...base.requiredCapabilities, SLOW_MOTION_CAPABILITY],
  };
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
