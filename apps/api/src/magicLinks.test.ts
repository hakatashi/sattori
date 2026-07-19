import { beforeEach, describe, expect, it } from "vitest";
import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import {
  extendMagicLinkExpiry,
  getMagicLink,
  MagicLinkAlreadyUsedError,
  markMagicLinkUsed,
  putMagicLink,
} from "./magicLinks.js";

const ddbMock = mockClient(DynamoDBDocumentClient);

const baseLink = {
  token: "token-1",
  jobId: "job-1",
  email: "user@example.com",
  replayKey: "replays/abc.rpy",
  game: "th07" as const,
  options: { watermark: true },
  estimatedDurationSeconds: 900,
};

describe("magicLinks", () => {
  beforeEach(() => {
    ddbMock.reset();
  });

  it("putMagicLink はusedAt=null・24時間後のexpiresAtでレコードを作る", async () => {
    ddbMock.on(PutCommand).resolves({});

    const record = await putMagicLink("magic-links-table", baseLink);

    expect(record.usedAt).toBeNull();
    expect(new Date(record.expiresAt).getTime() - new Date(record.createdAt).getTime()).toBe(
      24 * 60 * 60 * 1000,
    );
    const putCall = ddbMock.commandCalls(PutCommand)[0];
    expect(putCall?.args[0].input.ConditionExpression).toBe("attribute_not_exists(#token)");
  });

  it("getMagicLink は存在すればレコードを、存在しなければnullを返す", async () => {
    ddbMock.on(GetCommand).resolvesOnce({ Item: { ...baseLink, usedAt: null } }).resolvesOnce({});

    expect(await getMagicLink("magic-links-table", "token-1")).toMatchObject({ token: "token-1" });
    expect(await getMagicLink("magic-links-table", "missing")).toBeNull();
  });

  it("markMagicLinkUsed は未使用条件付きで更新する", async () => {
    ddbMock.on(UpdateCommand).resolves({});

    await markMagicLinkUsed("magic-links-table", "token-1");

    const updateCall = ddbMock.commandCalls(UpdateCommand)[0];
    expect(updateCall?.args[0].input.ConditionExpression).toContain("usedAt = :null");
  });

  it("markMagicLinkUsed は使用済みなら MagicLinkAlreadyUsedError を投げる", async () => {
    ddbMock.on(UpdateCommand).rejects(
      new ConditionalCheckFailedException({ message: "failed", $metadata: {} }),
    );

    await expect(markMagicLinkUsed("magic-links-table", "token-1")).rejects.toBeInstanceOf(
      MagicLinkAlreadyUsedError,
    );
  });

  it("extendMagicLinkExpiry は現在時刻から24時間先へexpiresAtを更新する", async () => {
    ddbMock.on(UpdateCommand).resolves({});

    const before = Date.now();
    const expiresAt = await extendMagicLinkExpiry("magic-links-table", "token-1");
    const after = Date.now();

    const expiresAtMs = new Date(expiresAt).getTime();
    expect(expiresAtMs).toBeGreaterThanOrEqual(before + 24 * 60 * 60 * 1000);
    expect(expiresAtMs).toBeLessThanOrEqual(after + 24 * 60 * 60 * 1000);
  });
});
