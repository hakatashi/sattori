import { describe, expect, it } from "vitest";
import type { TaggedInstance } from "./ec2.js";
import {
  ORPHAN_INSTANCE_GRACE_MS,
  groupInstancesByJobId,
  selectOrphanInstances,
} from "./orphanInstances.js";

const NOW = new Date("2026-08-14T12:00:00.000Z");

/** `NOW` から `minutes` 分前に起動したインスタンス。 */
function instance(instanceId: string, minutesAgo: number, jobId = "job-1"): TaggedInstance {
  return {
    instanceId,
    jobId,
    launchTime: new Date(NOW.getTime() - minutesAgo * 60 * 1000),
  };
}

describe("selectOrphanInstances", () => {
  it("実行が終わっているジョブの生存インスタンスは全て孤児", () => {
    const orphans = selectOrphanInstances({
      instances: [instance("i-aaa", 30), instance("i-bbb", 60)],
      executionLiveness: "finished",
      stopRequested: false,
      now: NOW,
    });

    expect(orphans).toEqual([
      { instanceId: "i-aaa", jobId: "job-1", reason: "execution_not_running" },
      { instanceId: "i-bbb", jobId: "job-1", reason: "execution_not_running" },
    ]);
  });

  it("実行が存在しない（履歴切れ・未起動）場合も同じく全て孤児", () => {
    const orphans = selectOrphanInstances({
      instances: [instance("i-aaa", 30)],
      executionLiveness: "absent",
      stopRequested: false,
      now: NOW,
    });

    expect(orphans.map((orphan) => orphan.instanceId)).toEqual(["i-aaa"]);
  });

  it("実行が生きているジョブでは最新の1台を必ず残し、古い試行の残骸だけを孤児にする", () => {
    // 「最新の1台」は今まさに録画しているかもしれない唯一のインスタンス。
    // ここを間違えるとユーザーの録画をその場で殺すことになる。
    const orphans = selectOrphanInstances({
      instances: [instance("i-old", 90), instance("i-new", 20), instance("i-older", 120)],
      executionLiveness: "running",
      stopRequested: false,
      now: NOW,
    });

    expect(orphans).toEqual([
      { instanceId: "i-old", jobId: "job-1", reason: "superseded_by_newer_attempt" },
      { instanceId: "i-older", jobId: "job-1", reason: "superseded_by_newer_attempt" },
    ]);
  });

  it("実行が生きていて1台しか無ければ何もしない（通常の録画中）", () => {
    expect(
      selectOrphanInstances({
        instances: [instance("i-aaa", 100)],
        executionLiveness: "running",
        stopRequested: false,
        now: NOW,
      }),
    ).toEqual([]);
  });

  it("猶予（ORPHAN_INSTANCE_GRACE_MS）内のインスタンスは対象にしない", () => {
    // `Launch` が instanceId をDynamoDBへ書く前に掃除が走る窓を守るための猶予。
    const graceMinutes = ORPHAN_INSTANCE_GRACE_MS / 60 / 1000;
    const orphans = selectOrphanInstances({
      instances: [instance("i-young", graceMinutes - 1), instance("i-old", graceMinutes + 1)],
      executionLiveness: "finished",
      stopRequested: false,
      now: NOW,
    });

    expect(orphans.map((orphan) => orphan.instanceId)).toEqual(["i-old"]);
  });

  it("起動時刻が読めないインスタンスは常に残す（判定できないものは殺さない）", () => {
    const orphans = selectOrphanInstances({
      instances: [
        { instanceId: "i-unknown", jobId: "job-1", launchTime: null },
        instance("i-old", 120),
      ],
      executionLiveness: "finished",
      stopRequested: false,
      now: NOW,
    });

    expect(orphans.map((orphan) => orphan.instanceId)).toEqual(["i-old"]);
  });

  it("緊急停止が要求されたジョブは実行が生きていても1台も残さない", () => {
    // `stopRequestedAt` は「このジョブのワーカーは全て黙らせる」という意思表示で、
    // 管理画面の停止処理（stopJob.ts）でterminateし損ねた分をここが引き取る。
    const orphans = selectOrphanInstances({
      instances: [instance("i-old", 90), instance("i-new", 20)],
      executionLiveness: "running",
      stopRequested: true,
      now: NOW,
    });

    expect(orphans).toEqual([
      { instanceId: "i-old", jobId: "job-1", reason: "stop_requested" },
      { instanceId: "i-new", jobId: "job-1", reason: "stop_requested" },
    ]);
  });

  it("インスタンスが無ければ空", () => {
    expect(
      selectOrphanInstances({
        instances: [],
        executionLiveness: "finished",
        stopRequested: false,
        now: NOW,
      }),
    ).toEqual([]);
  });
});

describe("groupInstancesByJobId", () => {
  it("ジョブIDごとにまとめる", () => {
    const grouped = groupInstancesByJobId([
      instance("i-aaa", 10, "job-1"),
      instance("i-bbb", 10, "job-2"),
      instance("i-ccc", 10, "job-1"),
    ]);

    expect([...grouped.keys()]).toEqual(["job-1", "job-2"]);
    expect(grouped.get("job-1")?.map((entry) => entry.instanceId)).toEqual(["i-aaa", "i-ccc"]);
  });
});
