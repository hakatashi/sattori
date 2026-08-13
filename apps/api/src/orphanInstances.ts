import { ORPHAN_INSTANCE_GRACE_MINUTES } from "@sattori/shared";
import type { TaggedInstance } from "./ec2.js";
import type { ExecutionLiveness } from "./stepFunctions.js";

/**
 * 孤児インスタンス（Issue #23）の判定ロジック。AWS APIを呼ばない純粋関数だけを
 * ここに置き、実際の走査とterminateは `handlers/sweepOrphanInstances.ts` が行う。
 *
 * ## なぜ孤児が生まれるのか
 *
 * `sfn/launch.ts` は EC2 Fleet の起動（＝課金開始）と `instanceId` のDynamoDBへの
 * 永続化が別ステップに分かれている。Lambdaタイムアウトやスロットリングで永続化の
 * 前に死ぬと、`handleFailure.ts` は terminate すべきインスタンスを知る術を失う
 * （そのためタグからも引くようにしてあるが、`DescribeInstances` 自体が失敗すれば
 * 同じことが起きる）。`HandleFailureCrashed` へ倒れた実行や、緊急停止
 * （`admin/stopJob.ts`）のterminate失敗も同じ結末になる。
 *
 * 孤児は**誰にも観測されないまま課金され続ける**のが最悪の性質で、ジョブ側の
 * どの状態遷移とも紐づかないため、後始末の経路をいくら足しても「その経路自体が
 * 失敗した場合」が必ず残る。だから最後の網はジョブではなく**AWS上の実在の
 * インスタンス**を起点に張る。
 *
 * ## 判定の方針
 *
 * 誤ってterminateすると**ユーザーの録画をその瞬間に殺す**（しかもワーカーは
 * `SendTaskFailure` すら送れず、15分のハートビートタイムアウトまで気づかれない）
 * ため、判定は徹底して安全側に倒す:
 *
 * - 起動から `ORPHAN_INSTANCE_GRACE_MINUTES` 経っていないインスタンスは対象外。
 * - Step Functions実行が生きているジョブでは、**最も新しい1台だけは必ず残す**
 *   （それが今まさに録画している可能性がある1台）。
 * - 実行の生死が判定できなかったジョブは丸ごと見送る（呼び出し側の責務）。
 */

/** 猶予（ミリ秒）。`ORPHAN_INSTANCE_GRACE_MINUTES` の単位を揃えただけのもの。 */
export const ORPHAN_INSTANCE_GRACE_MS = ORPHAN_INSTANCE_GRACE_MINUTES * 60 * 1000;

/** なぜ孤児と判断したか。ログにそのまま出して運用調査の手がかりにする。 */
export type OrphanReason =
  /** ジョブのStep Functions実行が既に終わっている（or 存在しない）のに生きている。 */
  | "execution_not_running"
  /** 管理画面から緊急停止（`stopRequestedAt`）されたジョブのインスタンス。 */
  | "stop_requested"
  /** 実行は生きているが、より新しい試行のインスタンスがある＝前の試行の残骸。 */
  | "superseded_by_newer_attempt";

export interface OrphanCandidate {
  instanceId: string;
  jobId: string;
  reason: OrphanReason;
}

export interface SelectOrphanInstancesInput {
  /** **同一ジョブの**生きているインスタンス全て（猶予内のものも必ず含めること）。 */
  instances: TaggedInstance[];
  /** そのジョブのStep Functions実行の生死（`stepFunctions.ts`）。 */
  executionLiveness: ExecutionLiveness;
  /** 管理画面から緊急停止が要求済みか（`JobRecord.stopRequestedAt`）。 */
  stopRequested: boolean;
  now: Date;
  /** テスト用の上書き。既定は `ORPHAN_INSTANCE_GRACE_MS`。 */
  graceMs?: number;
}

/**
 * 起動時刻。不明な場合は「たった今起動した」とみなす。**必ず安全側に倒すための
 * 既定値**で、これにより起動時刻が読めないインスタンスは猶予に守られて対象外になり、
 * かつ「最も新しい1台」の候補にもなる（＝残る側に回る）。
 */
function launchedAtMs(instance: TaggedInstance, now: Date): number {
  return instance.launchTime?.getTime() ?? now.getTime();
}

/**
 * 1ジョブぶんの生存インスタンスから、terminateすべき孤児を選ぶ。
 *
 * 実行が生きている間に複数台が生き残るのは、`Launch` のリトライ（最大10回）で
 * 前の試行のterminateに失敗した場合。**1回の試行が起動するインスタンスは高々1台**
 * なので、最新の1台が現行の試行、それ以外は残骸という対応づけが成立する。
 */
export function selectOrphanInstances({
  instances,
  executionLiveness,
  stopRequested,
  now,
  graceMs = ORPHAN_INSTANCE_GRACE_MS,
}: SelectOrphanInstancesInput): OrphanCandidate[] {
  if (instances.length === 0) {
    return [];
  }

  // 緊急停止が要求されたジョブは、実行が生きていても1台も残さない（`stopRequestedAt`
  // は「このジョブのワーカーは全て黙らせる」という意思表示であり、`stopJob.ts` の
  // terminate が失敗した後始末をここが引き取る）。
  const keepNewest = executionLiveness === "running" && !stopRequested;
  const newestInstanceId = keepNewest
    ? instances.reduce((newest, instance) =>
        launchedAtMs(instance, now) > launchedAtMs(newest, now) ? instance : newest,
      ).instanceId
    : null;

  const reason: OrphanReason = stopRequested
    ? "stop_requested"
    : executionLiveness === "running"
      ? "superseded_by_newer_attempt"
      : "execution_not_running";

  return instances
    .filter((instance) => instance.instanceId !== newestInstanceId)
    .filter((instance) => now.getTime() - launchedAtMs(instance, now) >= graceMs)
    .map((instance) => ({
      instanceId: instance.instanceId,
      jobId: instance.jobId,
      reason,
    }));
}

/** タグから拾ったインスタンスをジョブIDごとにまとめる。 */
export function groupInstancesByJobId(
  instances: TaggedInstance[],
): Map<string, TaggedInstance[]> {
  const grouped = new Map<string, TaggedInstance[]>();
  for (const instance of instances) {
    const bucket = grouped.get(instance.jobId);
    if (bucket === undefined) {
      grouped.set(instance.jobId, [instance]);
    } else {
      bucket.push(instance);
    }
  }
  return grouped;
}
