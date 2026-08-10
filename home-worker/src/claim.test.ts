/** オファー探索とclaim（Issue #49）のテスト。 */
import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { HOME_WORKER_OFFER_INDEX } from "@sattori/shared";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { claimJob, clearWorkerEnv, findOpenOffers, releaseClaim, touchClaim } from "./claim.js";

const ddbMock = mockClient(DynamoDBDocumentClient);
const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "eu-south-2" }));

beforeEach(() => {
  ddbMock.reset();
});

const conditionalFailure = (): ConditionalCheckFailedException =>
  new ConditionalCheckFailedException({ message: "no", $metadata: {} });

describe("findOpenOffers", () => {
  it("オファー探索はsparse GSIを期限で絞って引く", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [{ jobId: "job-1" }] });

    const items = await findOpenOffers(client, "jobs");

    expect(items).toEqual([{ jobId: "job-1" }]);
    const input = ddbMock.commandCalls(QueryCommand)[0]?.args[0].input;
    expect(input?.IndexName).toBe(HOME_WORKER_OFFER_INDEX);
    expect(input?.ExpressionAttributeValues).toMatchObject({ ":open": "open" });
    expect(input?.KeyConditionExpression).toContain("homeWorkerOfferExpiresAt > :now");
  });

  it("オファー探索は判断に必要な属性だけを射影する(他ジョブのtaskTokenを持ち帰らない)", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    await findOpenOffers(client, "jobs");

    const input = ddbMock.commandCalls(QueryCommand)[0]?.args[0].input;
    expect(input?.ProjectionExpression).toBe("jobId, game");
  });
});

describe("claimJob", () => {
  it("claimは未claimかつ期限内であることを条件にする", async () => {
    ddbMock.on(UpdateCommand).resolves({ Attributes: { jobId: "job-1", homeWorkerEnv: {} } });

    const job = await claimJob(client, "jobs", "job-1", "home-1");

    expect(job).toEqual({ jobId: "job-1", homeWorkerEnv: {} });
    const input = ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input;
    expect(input?.ConditionExpression).toContain("attribute_not_exists(assignedWorkerId)");
    expect(input?.ConditionExpression).toContain("homeWorkerOfferExpiresAt > :now");
    // コスト推定がworkerKindでEC2課金の有無を分岐するため、claimと同時に記録する。
    expect(input?.ExpressionAttributeValues?.[":kind"]).toBe("home");
    // 状態遷移もclaimと同じ更新で済ませる（AWS側が後追いで書くとコンテナが先に
    // 書いたrecordingを上書きしうるため）。
    expect(input?.ExpressionAttributeValues?.[":launching"]).toBe("launching");
    // オファーのマーカーを消してGSIから外す（他ワーカーが見に来ないように）。
    expect(input?.UpdateExpression).toContain("REMOVE homeWorkerOfferState");
  });

  it("他ワーカーに先を越されたclaimはnull", async () => {
    ddbMock.on(UpdateCommand).rejects(conditionalFailure());
    await expect(claimJob(client, "jobs", "job-1", "home-1")).resolves.toBeNull();
  });

  it("claim時の想定外エラーは伝播する", async () => {
    ddbMock.on(UpdateCommand).rejects(new Error("ThrottlingException"));
    await expect(claimJob(client, "jobs", "job-1", "home-1")).rejects.toThrow("ThrottlingException");
  });
});

describe("touchClaim", () => {
  it("claimが自分のものならtrue", async () => {
    ddbMock.on(UpdateCommand).resolves({});

    await expect(touchClaim(client, "jobs", "job-1", "home-1")).resolves.toBe(true);
    expect(ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input.ConditionExpression).toBe(
      "assignedWorkerId = :w",
    );
  });

  it("claimが取り消されていたらfalse", async () => {
    ddbMock.on(UpdateCommand).rejects(conditionalFailure());
    await expect(touchClaim(client, "jobs", "job-1", "home-1")).resolves.toBe(false);
  });
});

describe("releaseClaim", () => {
  it("claim解除は自分のものである場合のみ", async () => {
    ddbMock.on(UpdateCommand).resolves({});

    await releaseClaim(client, "jobs", "job-1", "home-1");

    const input = ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input;
    expect(input?.ConditionExpression).toBe("assignedWorkerId = :w");
    expect(input?.UpdateExpression).toContain("REMOVE assignedWorkerId");
  });

  it("既に解除済みなら何もしない", async () => {
    ddbMock.on(UpdateCommand).rejects(conditionalFailure());
    await expect(releaseClaim(client, "jobs", "job-1", "home-1")).resolves.toBeUndefined();
  });
});

describe("clearWorkerEnv", () => {
  it("使用済みtaskTokenを含む環境変数を消す", async () => {
    ddbMock.on(UpdateCommand).resolves({});

    await clearWorkerEnv(client, "jobs", "job-1", "home-1");

    expect(ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input.UpdateExpression).toBe(
      "REMOVE homeWorkerEnv",
    );
  });
});
