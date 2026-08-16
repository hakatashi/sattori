import { beforeEach, describe, expect, it } from "vitest";
import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { getOrCreateDailySalt } from "./analyticsSalt.js";

describe("getOrCreateDailySalt", () => {
  const ddbMock = mockClient(DynamoDBDocumentClient);

  beforeEach(() => {
    ddbMock.reset();
  });

  it("既にその日のsaltがあれば、それをそのまま返す", async () => {
    ddbMock
      .on(GetCommand)
      .resolves({ Item: { settingKey: "analyticsSalt#2026-08-16", salt: "existing-salt" } });

    const salt = await getOrCreateDailySalt("settings-table", "2026-08-16");

    expect(salt).toBe("existing-salt");
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  it("無ければ生成して条件付きPutで書き込み、その値を返す", async () => {
    ddbMock.on(GetCommand).resolvesOnce({});
    ddbMock.on(PutCommand).resolvesOnce({});

    const salt = await getOrCreateDailySalt("settings-table", "2026-08-16");

    expect(typeof salt).toBe("string");
    expect(salt.length).toBeGreaterThan(0);

    const putCalls = ddbMock.commandCalls(PutCommand);
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0]?.args[0].input).toMatchObject({
      TableName: "settings-table",
      Item: { settingKey: "analyticsSalt#2026-08-16", salt },
      ConditionExpression: "attribute_not_exists(settingKey)",
    });
  });

  it("同時生成で条件付きPutが競合したら、先に書き込まれた値を読み直して返す", async () => {
    ddbMock
      .on(GetCommand)
      .resolvesOnce({}) // 初回確認: まだ無い
      .resolvesOnce({
        Item: { settingKey: "analyticsSalt#2026-08-16", salt: "winner-salt" },
      }); // 競合後の読み直し
    ddbMock.on(PutCommand).rejectsOnce(
      new ConditionalCheckFailedException({
        message: "conflict",
        $metadata: {},
      }),
    );

    const salt = await getOrCreateDailySalt("settings-table", "2026-08-16");

    expect(salt).toBe("winner-salt");
  });
});
