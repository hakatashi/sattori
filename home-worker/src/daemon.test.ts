/**
 * デーモンのループ・claim取り消し検知のテスト。
 *
 * AWS呼び出しはすべて差し替え、`docker` も起動しない。ここで守りたいのは
 * 「対応外タイトルを取らない」「空きを超えて取らない」「claimが取り消されたら
 * 必ずコンテナを止める（＝二重録画を起こさない）」という判断のほうである。
 */
import { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { ECRClient, GetAuthorizationTokenCommand } from "@aws-sdk/client-ecr";
import { SFNClient } from "@aws-sdk/client-sfn";
import { DynamoDBDocumentClient, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HomeWorkerDaemon } from "./daemon.js";
import type { ClaimWatchTarget } from "./daemon.js";
import type { CredentialSource } from "./credentials.js";
import type { CommandResult, Killable, RunCommand, SpawnContainer } from "./runner.js";
import { Signal } from "./signal.js";
import { makeConfig } from "./testing.js";
import type { Config } from "./config.js";

const ddbMock = mockClient(DynamoDBDocumentClient);
// クライアントの実体は使われるが `send` はモックされるため、AWSへは一切出て行かない。
mockClient(DynamoDBClient);
/**
 * デーモンが触るAWSクライアントは**すべて**差し替える。`claimAndStartOffers()` は
 * claimに続けて `ecrLogin()`（ECR `GetAuthorizationToken`）まで進むため、ECRを
 * 差し替え忘れると、認証情報がある開発マシンでは実際にAWSを叩いて通り、CIでは
 * 認証情報の探索（IMDSを含む）で数秒待たされてタイムアウトする——実際にそれで
 * CIだけが落ちた。ログ転送(CloudWatch Logs)と失敗通知(Step Functions)も同様。
 */
const ecrMock = mockClient(ECRClient);
const sfnMock = mockClient(SFNClient);
const logsMock = mockClient(CloudWatchLogsClient);

beforeEach(() => {
  ddbMock.reset();
  ecrMock.reset();
  sfnMock.reset();
  logsMock.reset();
  ecrMock.on(GetAuthorizationTokenCommand).resolves({
    authorizationData: [{ authorizationToken: Buffer.from("AWS:password").toString("base64") }],
  });
});

/** ロールを持たない検証用の認証情報供給（AWSへは触れない）。 */
const credentials: CredentialSource = {
  clientCredentials: () => undefined,
  containerEnv: async () => ({}),
};

const OK: CommandResult = { code: 0, stdout: "", stderr: "" };

/**
 * `docker` を一切起動しないデーモン。`claimAndStartOffers()` はclaimに続けて
 * コンテナ起動まで行う（claimだけ済んで誰も実行しないジョブを作らないため）ので、
 * テストでは必ず起動系を差し替える。
 */
function makeDaemon(
  config: Config = makeConfig(),
  overrides: { runCommand?: RunCommand; spawnContainer?: SpawnContainer } = {},
): HomeWorkerDaemon {
  return new HomeWorkerDaemon(config, {
    credentials,
    log: () => undefined,
    claimCheckIntervalSec: 0.01,
    // 実マシンの負荷でテスト結果が揺れないよう固定する。
    loadPerCpu: () => 0,
    runCommand: overrides.runCommand ?? (async () => OK),
    // 既定では「起動した瞬間に正常終了するコンテナ」として振る舞う。
    spawnContainer: overrides.spawnContainer ?? (async () => 0),
  });
}

/**
 * 起動したまま終わらないコンテナ。`exit()` を呼ぶまで実行中のスロットを占め続ける
 * （テストの最後には必ず `exit()` すること。claim監視ループが回り続けるため）。
 */
function hangingContainer(): {
  spawnContainer: SpawnContainer;
  started: Promise<void>;
  exit: (code?: number) => void;
} {
  let notifyStarted: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    notifyStarted = resolve;
  });
  let finish: (code: number) => void = () => undefined;
  const spawnContainer: SpawnContainer = async () => {
    notifyStarted();
    return await new Promise<number>((resolve) => {
      finish = resolve;
    });
  };
  return { spawnContainer, started, exit: (code = 0): void => finish(code) };
}

/** GSIのQueryとclaimのUpdateだけに応答するモック。 */
function respondWithOffers(
  offers: { jobId: string; game: string }[],
  options: { claimable?: boolean } = {},
): void {
  ddbMock.on(QueryCommand).resolves({ Items: offers });
  ddbMock.on(PutCommand).resolves({});
  if (options.claimable === false) {
    ddbMock
      .on(UpdateCommand)
      .rejects(new ConditionalCheckFailedException({ message: "taken", $metadata: {} }));
    return;
  }
  ddbMock.on(UpdateCommand).callsFake((input: { Key?: { jobId?: string } }) => {
    const jobId = input.Key?.jobId ?? "";
    return { Attributes: { jobId, homeWorkerEnv: { TASK_TOKEN: "token" } } };
  });
}

/** claim（`assignedWorkerId` をSETするUpdate）が行われたジョブIDの一覧。 */
function claimedJobIds(): string[] {
  return updatesMatching("assignedWorkerId = :w").map((call) =>
    String((call.args[0].input.Key as { jobId?: string } | undefined)?.jobId),
  );
}

function updatesMatching(fragment: string) {
  return ddbMock
    .commandCalls(UpdateCommand)
    .filter((call) => String(call.args[0].input.UpdateExpression).includes(fragment));
}

describe("claimAndStartOffers", () => {
  it("対応していないタイトルのオファーはclaimしない", async () => {
    respondWithOffers([{ jobId: "job-1", game: "th11" }]);
    const daemon = makeDaemon(makeConfig({ supportedGames: ["th07"] }));

    await expect(daemon.claimAndStartOffers(2)).resolves.toEqual([]);
    expect(claimedJobIds()).toEqual([]);
  });

  it("空きスロットの数までしかclaimしない", async () => {
    respondWithOffers([
      { jobId: "job-1", game: "th07" },
      { jobId: "job-2", game: "th07" },
    ]);
    const daemon = makeDaemon();

    const claimed = await daemon.claimAndStartOffers(1);

    expect(claimed.map((job) => job.jobId)).toEqual(["job-1"]);
    expect(claimedJobIds()).toEqual(["job-1"]);
  });

  it("他ワーカーに先を越されても次のオファーへ進む", async () => {
    respondWithOffers([{ jobId: "job-1", game: "th07" }], { claimable: false });
    const daemon = makeDaemon();

    await expect(daemon.claimAndStartOffers(2)).resolves.toEqual([]);
  });

  it("claimが例外になったら自分名義のclaimを解除して打ち切る", async () => {
    // 応答が失われただけで書き込みは通っている可能性がある。放置すると「割り当て
    // 済みなのに誰も実行しないジョブ」が15分のタイムアウトまで凍る。
    ddbMock.on(QueryCommand).resolves({
      Items: [
        { jobId: "job-1", game: "th07" },
        { jobId: "job-2", game: "th07" },
      ],
    });
    ddbMock.on(PutCommand).resolves({});
    let claims = 0;
    ddbMock
      .on(UpdateCommand)
      .callsFake((input: { Key?: { jobId?: string }; UpdateExpression?: string }) => {
        if (!String(input.UpdateExpression).includes("assignedWorkerId = :w")) {
          return {};
        }
        claims += 1;
        if (claims === 2) {
          throw new Error("ThrottlingException");
        }
        return { Attributes: { jobId: input.Key?.jobId, homeWorkerEnv: { TASK_TOKEN: "token" } } };
      });
    const daemon = makeDaemon();

    const claimed = await daemon.claimAndStartOffers(2);

    // 1件目は起動済みとして返り、2件目は（成否不明なので）解除される。
    expect(claimed.map((job) => job.jobId)).toEqual(["job-1"]);
    const released = updatesMatching("REMOVE assignedWorkerId");
    expect(released).toHaveLength(1);
    expect((released[0]?.args[0].input.Key as { jobId?: string }).jobId).toBe("job-2");
  });

  it("実行中のジョブが再オファーされてもclaimし直さず、取り消しを確かめて停止する", async () => {
    // オファーは`attribute_not_exists(assignedWorkerId)`が条件なので、実行中の
    // ジョブの再出現はAWS側が割り当てを解除して出し直した強い兆候。二度claimすると
    // 同名コンテナの起動に失敗してリトライを1回無駄に消費する。
    const dockerCommands: string[][] = [];
    const container = hangingContainer();
    respondWithOffers([{ jobId: "job-1", game: "th07" }]);
    const daemon = makeDaemon(makeConfig({ maxConcurrency: 2 }), {
      runCommand: async (command) => {
        dockerCommands.push(command);
        return OK;
      },
      spawnContainer: container.spawnContainer,
    });

    await daemon.claimAndStartOffers(2);
    await container.started;
    expect(claimedJobIds()).toEqual(["job-1"]);

    // 2周目: 同じジョブがオファーに再出現し、claimは既に自分のものではない。
    ddbMock
      .on(UpdateCommand)
      .rejects(new ConditionalCheckFailedException({ message: "released", $metadata: {} }));

    await expect(daemon.claimAndStartOffers(2)).resolves.toEqual([]);

    expect(claimedJobIds()).toEqual(["job-1"]);
    expect(dockerCommands).toContainEqual(["docker", "kill", "sattori-job-job-1"]);

    container.exit(0);
    await vi.waitFor(() => expect(daemon.activeJobs()).toBe(0));
  });

  it("イメージのpull中に取り消されたらコンテナを起動しない", async () => {
    // pullは数分かかることがある。claimの監視をコンテナ起動後に始めていると、
    // この間の取り消しに気づけず、既にリトライが走っているジョブを録画し始める。
    respondWithOffers([{ jobId: "job-1", game: "th07" }]);
    let spawnCalls = 0;
    const daemon = makeDaemon(makeConfig(), {
      runCommand: async (command) => {
        if (command[1] === "pull") {
          // pullの最中にAWS側が割り当てを解除した状況を作る。
          ddbMock
            .on(UpdateCommand)
            .rejects(new ConditionalCheckFailedException({ message: "released", $metadata: {} }));
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return OK;
      },
      spawnContainer: async () => {
        spawnCalls += 1;
        return 0;
      },
    });

    await daemon.claimAndStartOffers(1);
    await vi.waitFor(() => expect(daemon.activeJobs()).toBe(0));

    expect(spawnCalls).toBe(0);
  });

  it("claimがまだ自分のものならオファーの残像とみなしてコンテナを止めない", async () => {
    // claim直後のGSIは結果整合で、自分が取ったジョブがまだオファーとして見える。
    const dockerCommands: string[][] = [];
    const container = hangingContainer();
    respondWithOffers([{ jobId: "job-1", game: "th07" }]);
    const daemon = makeDaemon(makeConfig({ maxConcurrency: 2 }), {
      runCommand: async (command) => {
        dockerCommands.push(command);
        return OK;
      },
      spawnContainer: container.spawnContainer,
    });

    await daemon.claimAndStartOffers(2);
    await container.started;
    await daemon.claimAndStartOffers(2);

    expect(claimedJobIds()).toEqual(["job-1"]);
    expect(dockerCommands.some((command) => command[1] === "kill")).toBe(false);

    container.exit(0);
    await vi.waitFor(() => expect(daemon.activeJobs()).toBe(0));
  });
});

describe("publishHeartbeat", () => {
  it("ハートビートは間隔を空けて書く", async () => {
    ddbMock.on(PutCommand).resolves({});
    const daemon = makeDaemon();

    await daemon.publishHeartbeat(true, 0);
    await daemon.publishHeartbeat(true, 0);

    const calls = ddbMock.commandCalls(PutCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[0].input.Item).toMatchObject({ accepting: true, kind: "home" });
  });

  it("forceを指定すれば間引きを無視して書く", async () => {
    ddbMock.on(PutCommand).resolves({});
    const daemon = makeDaemon();

    await daemon.publishHeartbeat(true, 0);
    await daemon.publishHeartbeat(false, 1, { force: true });

    const calls = ddbMock.commandCalls(PutCommand);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.args[0].input.Item).toMatchObject({ accepting: false, activeJobs: 1 });
  });

  it("claim直後は空き状況を書き直す(誰もclaimできないジョブのオファーを招かない)", async () => {
    // 間引き（15秒）に任せると、スロットが埋まった後もAWSからは「空きあり」に
    // 見え、オファーが吸い込まれてEC2へのフォールバックが丸ごと遅れる。
    const container = hangingContainer();
    respondWithOffers([{ jobId: "job-1", game: "th07" }]);
    const daemon = makeDaemon(makeConfig({ maxConcurrency: 1 }), {
      spawnContainer: container.spawnContainer,
    });

    await daemon.tick();

    const heartbeats = ddbMock.commandCalls(PutCommand).map((call) => call.args[0].input.Item);
    expect(heartbeats).toHaveLength(2);
    expect(heartbeats[0]).toMatchObject({ accepting: true, activeJobs: 0 });
    expect(heartbeats[1]).toMatchObject({ accepting: false, activeJobs: 1 });

    await container.started;
    container.exit(0);
    await vi.waitFor(() => expect(daemon.activeJobs()).toBe(0));
  });
});

class FakeContainer implements Killable {
  killed = false;
  /** `kill()` を何回試みられたか（失敗時の再試行を数える）。 */
  killAttempts = 0;
  /** true なら `docker kill` の失敗を模して例外を投げる。 */
  failKill = false;

  async kill(): Promise<void> {
    this.killAttempts += 1;
    if (this.failKill) {
      throw new Error("docker kill に失敗しました(exit=1)");
    }
    this.killed = true;
  }
}

function makeTarget(container: Killable | null = null): ClaimWatchTarget {
  return { revoked: new Signal(), finished: new Signal(), container };
}

describe("watchClaim", () => {
  it("claimが取り消されたらコンテナを止める", async () => {
    ddbMock
      .on(UpdateCommand)
      .rejects(new ConditionalCheckFailedException({ message: "released", $metadata: {} }));
    const container = new FakeContainer();
    const target = makeTarget(container);
    const daemon = makeDaemon();

    const watching = daemon.watchClaim("job-1", target);
    await vi.waitFor(() => expect(container.killed).toBe(true));
    target.finished.set();
    await watching;
  });

  it("claim確認の一時的な失敗ではコンテナを止めない", async () => {
    let attempts = 0;
    ddbMock.on(UpdateCommand).callsFake(() => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("ThrottlingException");
      }
      throw new ConditionalCheckFailedException({ message: "released", $metadata: {} });
    });
    const container = new FakeContainer();
    const target = makeTarget(container);
    const daemon = makeDaemon();

    const watching = daemon.watchClaim("job-1", target);
    await vi.waitFor(() => expect(container.killed).toBe(true));
    target.finished.set();
    await watching;

    // 1回目は握りつぶして継続し、2回目の「取り消し済み」で初めて停止する。
    expect(attempts).toBeGreaterThanOrEqual(2);
  });

  it("docker killが失敗したら停止済みとして扱わず再試行する", async () => {
    // 失敗を無視して`killed`を立てると、生き残ったコンテナが録画を完走する一方で
    // 成否の通知もログも省かれ、二重録画が誰にも気づかれない。
    ddbMock
      .on(UpdateCommand)
      .rejects(new ConditionalCheckFailedException({ message: "released", $metadata: {} }));
    const container = new FakeContainer();
    container.failKill = true;
    const target = makeTarget(container);
    const daemon = makeDaemon();

    const watching = daemon.watchClaim("job-1", target);
    await vi.waitFor(() => expect(container.killAttempts).toBeGreaterThanOrEqual(2));
    target.finished.set();
    await watching;

    expect(container.killed).toBe(false);
  });

  it("コンテナ起動前に取り消されたら取り消しフラグだけを立てる", async () => {
    // イメージのpull中に取り消されることもある。その場合はコンテナを起動しない
    // （起動側が `revoked` を見て中止する）。
    ddbMock
      .on(UpdateCommand)
      .rejects(new ConditionalCheckFailedException({ message: "released", $metadata: {} }));
    const target = makeTarget(null);
    const daemon = makeDaemon();

    const watching = daemon.watchClaim("job-1", target);
    await vi.waitFor(() => expect(target.revoked.isSet).toBe(true));
    target.finished.set();
    await watching;
  });
});
