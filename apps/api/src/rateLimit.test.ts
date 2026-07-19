import { beforeEach, describe, expect, it } from "vitest";
import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { checkAndRecordRateLimit, normalizeEmailForRateLimit } from "./rateLimit.js";

function conditionalCheckFailed(): ConditionalCheckFailedException {
  return new ConditionalCheckFailedException({
    message: "condition failed",
    $metadata: {},
  });
}

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

  it("有効なウィンドウ内で件数が上限未満なら、1回のUpdateCommandで許可・記録する", async () => {
    ddbMock.on(UpdateCommand).resolvesOnce({});

    const result = await checkAndRecordRateLimit("rate-limit-table", "aaa+bbb@ccc.com");

    expect(result.allowed).toBe(true);
    const calls = ddbMock.commandCalls(UpdateCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[0].input.Key).toEqual({ normalizedEmail: "aaa@ccc.com" });
    expect(calls[0]?.args[0].input.ConditionExpression).toContain("requestCount < :max");
  });

  it("itemが存在しない(初回)場合は、ウィンドウを新規作成して許可する", async () => {
    ddbMock
      .on(UpdateCommand)
      .rejectsOnce(conditionalCheckFailed()) // インクリメント: itemなしで失敗
      .resolvesOnce({}); // リセット: 新規ウィンドウ作成で成功

    const result = await checkAndRecordRateLimit("rate-limit-table", "aaa@ccc.com");

    expect(result.allowed).toBe(true);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(2);
  });

  it("有効なウィンドウ内で件数が上限に達していれば拒否する", async () => {
    // インクリメント(上限到達で失敗)・リセット(ウィンドウがまだ有効なので失敗)が
    // 再試行しても状態が変わらず失敗し続けるケース。
    ddbMock.on(UpdateCommand).rejects(conditionalCheckFailed());

    const result = await checkAndRecordRateLimit("rate-limit-table", "aaa@ccc.com");

    expect(result.allowed).toBe(false);
  });

  it("同時到着した2件のリクエストは、どちらも上限を超えずに順にカウントされる", async () => {
    // 1件目: itemなし → リセットで新規作成(1件目としてカウント)
    // 2件目: 1件目のリセット後にインクリメントを試みて成功(2件目としてカウント)
    ddbMock
      .on(UpdateCommand)
      .rejectsOnce(conditionalCheckFailed())
      .resolvesOnce({})
      .resolvesOnce({});

    const first = await checkAndRecordRateLimit("rate-limit-table", "aaa@ccc.com");
    const second = await checkAndRecordRateLimit("rate-limit-table", "aaa@ccc.com");

    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(3);
  });

  it("インクリメント・リセットの両方が失敗し続けたリクエストは、規定回数の再試行後に拒否する", async () => {
    ddbMock.on(UpdateCommand).rejects(conditionalCheckFailed());

    const result = await checkAndRecordRateLimit("rate-limit-table", "aaa@ccc.com");

    expect(result.allowed).toBe(false);
  });

  it("キーに正規化後のメールアドレスを使う", async () => {
    ddbMock.on(UpdateCommand).resolvesOnce({});

    await checkAndRecordRateLimit("rate-limit-table", "AAA+xxx@CCC.com");

    const calls = ddbMock.commandCalls(UpdateCommand);
    expect(calls[0]?.args[0].input.Key).toEqual({ normalizedEmail: "aaa@ccc.com" });
  });
});
