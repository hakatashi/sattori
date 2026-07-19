import { beforeEach, describe, expect, it } from "vitest";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { checkAndRecordRateLimit, normalizeEmailForRateLimit } from "./rateLimit.js";

describe("normalizeEmailForRateLimit", () => {
  it("大文字小文字を無視する", () => {
    expect(normalizeEmailForRateLimit("AAA@CCC.com")).toBe("aaa@ccc.com");
  });

  it("ローカル部の + エイリアスを同一視する", () => {
    expect(normalizeEmailForRateLimit("aaa+bbb@ccc.com")).toBe("aaa@ccc.com");
    expect(normalizeEmailForRateLimit("aaa@ccc.com")).toBe("aaa@ccc.com");
  });

  it("大文字小文字と + エイリアスを組み合わせても同一視する", () => {
    expect(normalizeEmailForRateLimit("AAA+bbb@CCC.com")).toBe(
      normalizeEmailForRateLimit("aaa@ccc.com"),
    );
  });

  it("ドット等、+以外のエイリアス規則は正規化しない", () => {
    expect(normalizeEmailForRateLimit("a.a.a@ccc.com")).toBe("a.a.a@ccc.com");
  });
});

describe("checkAndRecordRateLimit", () => {
  const ddbMock = mockClient(DynamoDBDocumentClient);

  beforeEach(() => {
    ddbMock.reset();
  });

  it("直近24時間の件数が上限未満なら許可し、カウンタに記録する", async () => {
    ddbMock.on(QueryCommand).resolves({ Count: 4 });
    ddbMock.on(PutCommand).resolves({});

    const result = await checkAndRecordRateLimit("rate-limit-table", "aaa+bbb@ccc.com");

    expect(result.allowed).toBe(true);
    const putCalls = ddbMock.commandCalls(PutCommand);
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0]?.args[0].input.Item?.normalizedEmail).toBe("aaa@ccc.com");
  });

  it("直近24時間の件数が上限に達していれば拒否し、記録しない", async () => {
    ddbMock.on(QueryCommand).resolves({ Count: 5 });

    const result = await checkAndRecordRateLimit("rate-limit-table", "aaa@ccc.com");

    expect(result.allowed).toBe(false);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  it("クエリのキー条件に正規化後のメールアドレスを使う", async () => {
    ddbMock.on(QueryCommand).resolves({ Count: 0 });
    ddbMock.on(PutCommand).resolves({});

    await checkAndRecordRateLimit("rate-limit-table", "AAA+xxx@CCC.com");

    const queryCalls = ddbMock.commandCalls(QueryCommand);
    expect(queryCalls[0]?.args[0].input.ExpressionAttributeValues?.[":e"]).toBe("aaa@ccc.com");
  });
});
