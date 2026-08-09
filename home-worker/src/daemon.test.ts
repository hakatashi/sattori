/**
 * デーモンのループ・claim取り消し検知のテスト。
 *
 * AWS呼び出しはすべて差し替え、`docker` も起動しない。ここで守りたいのは
 * 「対応外タイトルを取らない」「空きを超えて取らない」「claimが取り消されたら
 * 必ずコンテナを止める（＝二重録画を起こさない）」という判断のほうである。
 */
import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { HomeWorkerDaemon } from "./daemon.js";
import type { CredentialSource } from "./credentials.js";
import type { Killable } from "./runner.js";
import { Signal } from "./signal.js";
import { makeConfig } from "./testing.js";
import type { Config } from "./config.js";

const ddbMock = mockClient(DynamoDBDocumentClient);
// クライアントの実体は使われるが `send` はモックされるため、AWSへは一切出て行かない。
mockClient(DynamoDBClient);

beforeEach(() => {
  ddbMock.reset();
});

/** ロールを持たない検証用の認証情報供給（AWSへは触れない）。 */
const credentials: CredentialSource = {
  clientCredentials: () => undefined,
  containerEnv: async () => ({}),
};

function makeDaemon(config: Config = makeConfig()): HomeWorkerDaemon {
  return new HomeWorkerDaemon(config, {
    credentials,
    log: () => undefined,
    claimCheckIntervalSec: 0.01,
  });
}

/** GSIのQueryとclaimのUpdateだけに応答するモック。 */
function respondWithOffers(
  offers: { jobId: string; game: string }[],
  options: { claimable?: boolean } = {},
): void {
  const claimed: string[] = [];
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
    claimed.push(jobId);
    return { Attributes: { jobId, homeWorkerEnv: {} } };
  });
}

/** claim（`assignedWorkerId` をSETするUpdate）が行われたジョブIDの一覧。 */
function claimedJobIds(): string[] {
  return ddbMock
    .commandCalls(UpdateCommand)
    .filter((call) => String(call.args[0].input.UpdateExpression).includes("assignedWorkerId = :w"))
    .map((call) => String((call.args[0].input.Key as { jobId?: string } | undefined)?.jobId));
}

describe("claimOffers", () => {
  it("対応していないタイトルのオファーはclaimしない", async () => {
    respondWithOffers([{ jobId: "job-1", game: "th11" }]);
    const daemon = makeDaemon(makeConfig({ supportedGames: ["th07"] }));

    await expect(daemon.claimOffers(2)).resolves.toEqual([]);
    expect(claimedJobIds()).toEqual([]);
  });

  it("空きスロットの数までしかclaimしない", async () => {
    respondWithOffers([
      { jobId: "job-1", game: "th07" },
      { jobId: "job-2", game: "th07" },
    ]);
    const daemon = makeDaemon();

    const claimed = await daemon.claimOffers(1);

    expect(claimed.map((job) => job.jobId)).toEqual(["job-1"]);
    expect(claimedJobIds()).toEqual(["job-1"]);
  });

  it("他ワーカーに先を越されても次のオファーへ進む", async () => {
    respondWithOffers([{ jobId: "job-1", game: "th07" }], { claimable: false });
    const daemon = makeDaemon();

    await expect(daemon.claimOffers(2)).resolves.toEqual([]);
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
});

class FakeContainer implements Killable {
  killed = false;

  async kill(): Promise<void> {
    this.killed = true;
  }
}

describe("watchClaim", () => {
  it("claimが取り消されたらコンテナを止める", async () => {
    ddbMock
      .on(UpdateCommand)
      .rejects(new ConditionalCheckFailedException({ message: "released", $metadata: {} }));
    const container = new FakeContainer();
    const daemon = makeDaemon();

    await daemon.watchClaim("job-1", container, new Signal());

    expect(container.killed).toBe(true);
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
    const daemon = makeDaemon();

    await daemon.watchClaim("job-1", container, new Signal());

    // 1回目は握りつぶして継続し、2回目の「取り消し済み」で初めて停止する。
    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(container.killed).toBe(true);
  });
});
