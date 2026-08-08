import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import {
  getAssignedWorkerId,
  listWorkerHeartbeats,
  offerJobToHomeWorker,
  releaseHomeWorkerAssignment,
  waitForHomeWorkerClaim,
  withdrawHomeWorkerOffer,
} from "./homeWorker.js";

const ddbMock = mockClient(DynamoDBDocumentClient);

beforeEach(() => {
  ddbMock.reset();
});

const conditionalFailure = () =>
  new ConditionalCheckFailedException({ message: "conditional", $metadata: {} });

describe("listWorkerHeartbeats", () => {
  it("Scanの結果をそのまま返す(常駐ワーカーは数台なのでページングは不要)", async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [{ workerId: "home-1" }] });
    await expect(listWorkerHeartbeats("workers")).resolves.toEqual([{ workerId: "home-1" }]);
  });

  it("アイテムが無ければ空配列", async () => {
    ddbMock.on(ScanCommand).resolves({});
    await expect(listWorkerHeartbeats("workers")).resolves.toEqual([]);
  });
});

describe("offerJobToHomeWorker", () => {
  it("オファー属性と環境変数を書き込み、未claimであることを条件にする", async () => {
    ddbMock.on(UpdateCommand).resolves({});

    await expect(
      offerJobToHomeWorker({
        jobsTable: "jobs",
        jobId: "job-1",
        env: { JOB_ID: "job-1", TASK_TOKEN: "token" },
        expiresAt: "2026-08-09T12:00:20.000Z",
      }),
    ).resolves.toBe(true);

    const input = ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input;
    expect(input?.ConditionExpression).toBe("attribute_not_exists(assignedWorkerId)");
    expect(input?.ExpressionAttributeValues).toMatchObject({
      ":open": "open",
      ":exp": "2026-08-09T12:00:20.000Z",
      ":env": { JOB_ID: "job-1", TASK_TOKEN: "token" },
    });
  });

  it("既にclaim済みならオファーせずfalse", async () => {
    ddbMock.on(UpdateCommand).rejects(conditionalFailure());
    await expect(
      offerJobToHomeWorker({
        jobsTable: "jobs",
        jobId: "job-1",
        env: {},
        expiresAt: "2026-08-09T12:00:20.000Z",
      }),
    ).resolves.toBe(false);
  });
});

describe("withdrawHomeWorkerOffer", () => {
  it("オファー属性を消して true を返す", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    await expect(withdrawHomeWorkerOffer("jobs", "job-1")).resolves.toBe(true);
    const input = ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input;
    expect(input?.UpdateExpression).toContain("REMOVE homeWorkerOfferState");
    expect(input?.ConditionExpression).toBe("attribute_not_exists(assignedWorkerId)");
  });

  it("撤回直前にclaimされていたら false（＝EC2を起動してはいけない）", async () => {
    ddbMock.on(UpdateCommand).rejects(conditionalFailure());
    await expect(withdrawHomeWorkerOffer("jobs", "job-1")).resolves.toBe(false);
  });
});

describe("getAssignedWorkerId", () => {
  it("claim直後を取りこぼさないよう強い整合性で読む", async () => {
    ddbMock.on(GetCommand).resolves({ Item: { assignedWorkerId: "home-1" } });
    await expect(getAssignedWorkerId("jobs", "job-1")).resolves.toBe("home-1");
    expect(ddbMock.commandCalls(GetCommand)[0]?.args[0].input.ConsistentRead).toBe(true);
  });

  it("未claimならnull", async () => {
    ddbMock.on(GetCommand).resolves({ Item: {} });
    await expect(getAssignedWorkerId("jobs", "job-1")).resolves.toBeNull();
  });
});

describe("releaseHomeWorkerAssignment", () => {
  it("割り当てとオファーの両方を消す（無条件）", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    await releaseHomeWorkerAssignment("jobs", "job-1");
    const input = ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input;
    expect(input?.UpdateExpression).toContain("REMOVE assignedWorkerId");
    expect(input?.UpdateExpression).toContain("homeWorkerOfferState");
    expect(input?.ConditionExpression).toBeUndefined();
  });
});

describe("waitForHomeWorkerClaim", () => {
  it("claimされた時点でワーカーIDを返す", async () => {
    ddbMock
      .on(GetCommand)
      .resolvesOnce({ Item: {} })
      .resolves({ Item: { assignedWorkerId: "home-1" } });
    const sleep = vi.fn(async () => {});

    await expect(
      waitForHomeWorkerClaim({
        jobsTable: "jobs",
        jobId: "job-1",
        deadline: 10_000,
        intervalMs: 100,
        sleep,
        now: () => 0,
      }),
    ).resolves.toBe("home-1");
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("締め切りを過ぎたらnullを返す", async () => {
    ddbMock.on(GetCommand).resolves({ Item: {} });
    await expect(
      waitForHomeWorkerClaim({
        jobsTable: "jobs",
        jobId: "job-1",
        deadline: 0,
        intervalMs: 100,
        sleep: async () => {},
        now: () => 0,
      }),
    ).resolves.toBeNull();
  });

  it("残り時間より長く眠らない(オファー期限を超えて待たない)", async () => {
    ddbMock.on(GetCommand).resolves({ Item: {} });
    const sleep = vi.fn(async () => {});
    let current = 0;
    await waitForHomeWorkerClaim({
      jobsTable: "jobs",
      jobId: "job-1",
      deadline: 50,
      intervalMs: 2000,
      sleep,
      now: () => {
        const value = current;
        current = 50;
        return value;
      },
    });
    expect(sleep).toHaveBeenCalledWith(50);
  });
});
