import { beforeEach, describe, expect, it } from "vitest";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import type { AdminJobSummary } from "@sattori/shared";
import {
  decodeCursor,
  encodeCursor,
  listJobs,
  normalizeLimit,
  STATUS_CREATED_AT_INDEX,
  type JobsCursor,
} from "./adminJobs.js";

const ddbMock = mockClient(DynamoDBDocumentClient);

function summary(jobId: string, createdAt: string, status: AdminJobSummary["status"]): AdminJobSummary {
  return {
    jobId,
    game: "th11",
    status,
    createdAt,
    updatedAt: createdAt,
    email: null,
    error: null,
    instanceType: null,
    availabilityZone: null,
    progress: null,
    replayInfo: null,
  };
}

describe("normalizeLimit", () => {
  it("未指定・不正値は既定値(20)を返す", () => {
    expect(normalizeLimit(undefined)).toBe(20);
    expect(normalizeLimit("abc")).toBe(20);
    expect(normalizeLimit("0")).toBe(20);
    expect(normalizeLimit("-5")).toBe(20);
  });

  it("上限(100)にクランプする", () => {
    expect(normalizeLimit("101")).toBe(100);
    expect(normalizeLimit("9999")).toBe(100);
  });

  it("有効な範囲内の値はそのまま(整数化して)使う", () => {
    expect(normalizeLimit("50")).toBe(50);
    expect(normalizeLimit("1")).toBe(1);
    expect(normalizeLimit("30.9")).toBe(30);
  });
});

describe("encodeCursor / decodeCursor", () => {
  it("往復できる", () => {
    const cursor = {
      done: { createdAt: "2026-07-30T00:00:00.000Z", jobId: "job-1" },
      failed: { createdAt: "2026-07-29T00:00:00.000Z", jobId: "job-2" },
    };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it("空のカーソルも往復できる", () => {
    expect(decodeCursor(encodeCursor({}))).toEqual({});
  });

  it("不正なカーソルはnullを返す", () => {
    const b64 = (value: string) => Buffer.from(value, "utf8").toString("base64url");
    expect(decodeCursor("not-base64url!!!")).toBeNull();
    expect(decodeCursor(b64("[]"))).toBeNull();
    // 未知のstatusキー
    expect(decodeCursor(b64('{"bogus":{"createdAt":"2026-07-30T00:00:00.000Z","jobId":"j"}}'))).toBeNull();
    // エントリの形が不正
    expect(decodeCursor(b64('{"done":"job-1"}'))).toBeNull();
    expect(decodeCursor(b64('{"done":{"createdAt":"2026-07-30T00:00:00.000Z"}}'))).toBeNull();
    // createdAtとして解釈できない
    expect(decodeCursor(b64('{"done":{"createdAt":"invalid-date","jobId":"job-1"}}'))).toBeNull();
  });
});

describe("listJobs", () => {
  beforeEach(() => {
    ddbMock.reset();
  });

  it("statusを指定した場合はQueryを1回だけ、IndexNameとKeyConditionExpressionを指定して呼ぶ", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [summary("job-1", "2026-07-30T00:00:00.000Z", "done")] });

    const result = await listJobs("jobs-table", { status: "done", limit: 20 });

    expect(result.items).toHaveLength(1);
    const calls = ddbMock.commandCalls(QueryCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[0].input).toMatchObject({
      IndexName: STATUS_CREATED_AT_INDEX,
      KeyConditionExpression: "#status = :status",
      ExpressionAttributeValues: { ":status": "done" },
      ScanIndexForward: false,
    });
  });

  it("status未指定の場合は全ステータス(7個)ぶんQueryする", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    await listJobs("jobs-table", { limit: 20 });

    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(7);
  });

  it("複数ステータスの結果をcreatedAt降順でマージする", async () => {
    // aws-sdk-client-mockは後から登録したマッチャーほど優先される(LIFO)ため、
    // catch-all(マッチャー無し)を先に登録し、個別マッチャーを後から重ねる。
    ddbMock
      .on(QueryCommand)
      .resolves({ Items: [] })
      .on(QueryCommand, { ExpressionAttributeValues: { ":status": "done" } })
      .resolves({ Items: [summary("done-1", "2026-07-30T00:00:00.000Z", "done")] })
      .on(QueryCommand, { ExpressionAttributeValues: { ":status": "failed" } })
      .resolves({ Items: [summary("failed-1", "2026-07-31T00:00:00.000Z", "failed")] });

    const result = await listJobs("jobs-table", { limit: 20 });

    expect(result.items.map((i) => i.jobId)).toEqual(["failed-1", "done-1"]);
  });

  it("createdAtが同値の場合はjobId降順でタイブレークする", async () => {
    ddbMock
      .on(QueryCommand)
      .resolves({ Items: [] })
      .on(QueryCommand, { ExpressionAttributeValues: { ":status": "done" } })
      .resolves({ Items: [summary("job-a", "2026-07-30T00:00:00.000Z", "done")] })
      .on(QueryCommand, { ExpressionAttributeValues: { ":status": "failed" } })
      .resolves({ Items: [summary("job-b", "2026-07-30T00:00:00.000Z", "failed")] });

    const result = await listJobs("jobs-table", { limit: 20 });

    expect(result.items.map((i) => i.jobId)).toEqual(["job-b", "job-a"]);
  });

  it("複数ストリームに同一jobIdが現れた場合はdedupeする(status遷移中の競合を想定)", async () => {
    ddbMock
      .on(QueryCommand)
      .resolves({ Items: [] })
      .on(QueryCommand, { ExpressionAttributeValues: { ":status": "queued" } })
      .resolves({ Items: [summary("job-1", "2026-07-30T00:00:00.000Z", "queued")] })
      .on(QueryCommand, { ExpressionAttributeValues: { ":status": "recording" } })
      .resolves({ Items: [summary("job-1", "2026-07-30T00:00:00.000Z", "recording")] });

    const result = await listJobs("jobs-table", { limit: 20 });

    expect(result.items).toHaveLength(1);
  });

  it("limit件で打ち切り、nextCursorにstatus毎の最後の採用アイテムを入れる", async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        summary("job-3", "2026-07-30T00:00:03.000Z", "done"),
        summary("job-2", "2026-07-30T00:00:02.000Z", "done"),
        summary("job-1", "2026-07-30T00:00:01.000Z", "done"),
      ],
    });

    const result = await listJobs("jobs-table", { status: "done", limit: 2 });

    expect(result.items.map((i) => i.jobId)).toEqual(["job-3", "job-2"]);
    expect(result.nextCursor).toEqual({
      done: { createdAt: "2026-07-30T00:00:02.000Z", jobId: "job-2" },
    });
  });

  it("1件も採用されなかったstatusのカーソルは前回値を据え置く", async () => {
    ddbMock
      .on(QueryCommand)
      .resolves({ Items: [] })
      .on(QueryCommand, { ExpressionAttributeValues: { ":status": "done" } })
      .resolves({
        Items: [
          summary("done-2", "2026-07-30T00:00:02.000Z", "done"),
          summary("done-1", "2026-07-30T00:00:01.000Z", "done"),
        ],
      });

    const result = await listJobs("jobs-table", {
      limit: 1,
      cursor: { failed: { createdAt: "2020-01-01T00:00:00.000Z", jobId: "failed-old" } },
    });

    expect(result.items.map((i) => i.jobId)).toEqual(["done-2"]);
    expect(result.nextCursor).toEqual({
      done: { createdAt: "2026-07-30T00:00:02.000Z", jobId: "done-2" },
      failed: { createdAt: "2020-01-01T00:00:00.000Z", jobId: "failed-old" },
    });
  });

  it("ページ内に収まる件数しかない場合はnextCursorがnull", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [summary("job-1", "2026-07-30T00:00:00.000Z", "done")] });

    const result = await listJobs("jobs-table", { status: "done", limit: 20 });

    expect(result.nextCursor).toBeNull();
  });

  it("DynamoDBがLastEvaluatedKeyを返した場合、ページ内件数がlimit以下でもnextCursorを返す", async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [summary("job-1", "2026-07-30T00:00:00.000Z", "done")],
      LastEvaluatedKey: { jobId: "job-1", status: "done" },
    });

    const result = await listJobs("jobs-table", { status: "done", limit: 20 });

    expect(result.nextCursor).not.toBeNull();
  });

  it("カーソル指定時はstatus毎にExclusiveStartKeyで再開する", async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [summary("job-1", "2026-07-30T00:00:01.000Z", "done")],
    });

    const result = await listJobs("jobs-table", {
      status: "done",
      limit: 20,
      cursor: { done: { createdAt: "2026-07-30T00:00:02.000Z", jobId: "job-2" } },
    });

    expect(result.items.map((i) => i.jobId)).toEqual(["job-1"]);
    const calls = ddbMock.commandCalls(QueryCommand);
    expect(calls[0]?.args[0].input).toMatchObject({
      KeyConditionExpression: "#status = :status",
      ExpressionAttributeValues: { ":status": "done" },
      // GSIのExclusiveStartKeyは索引キー(status, createdAt)+テーブルPK(jobId)が要る
      ExclusiveStartKey: {
        status: "done",
        createdAt: "2026-07-30T00:00:02.000Z",
        jobId: "job-2",
      },
    });
  });

  it("hasMoreの判定に使うためLimitはlimitより1件多く要求する", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    await listJobs("jobs-table", { status: "done", limit: 20 });

    expect(ddbMock.commandCalls(QueryCommand)[0]?.args[0].input).toMatchObject({ Limit: 21 });
  });
});

/**
 * DynamoDBのQueryを模したフェイク。status毎のアイテム列をcreatedAt降順に並べ、
 * `ExclusiveStartKey`・`Limit`を実挙動どおりに解釈する。**`Limit`に達して打ち切った
 * 場合は後続の有無に関わらず`LastEvaluatedKey`を返す**（実際のDynamoDBの挙動。
 * `listJobs`の「空ページへ進む次へボタンを出さない」性質はこれを前提にしている）。
 */
function fakeQuery(itemsByStatus: Partial<Record<AdminJobSummary["status"], AdminJobSummary[]>>) {
  return (input: {
    ExpressionAttributeValues?: Record<string, unknown>;
    ExclusiveStartKey?: Record<string, unknown>;
    Limit?: number;
  }) => {
    const status = input.ExpressionAttributeValues?.[":status"] as AdminJobSummary["status"];
    const all = [...(itemsByStatus[status] ?? [])].sort((a, b) =>
      a.createdAt === b.createdAt ? (a.jobId < b.jobId ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1,
    );
    const startKey = input.ExclusiveStartKey;
    const start = startKey ? all.findIndex((i) => i.jobId === startKey.jobId) + 1 : 0;
    const limit = input.Limit ?? all.length;
    const items = all.slice(start, start + limit);
    const last = items[items.length - 1];
    return {
      Items: items,
      ...(items.length === limit && last
        ? { LastEvaluatedKey: { status, createdAt: last.createdAt, jobId: last.jobId } }
        : {}),
    };
  };
}

describe("listJobs のページング（全件走査）", () => {
  beforeEach(() => {
    ddbMock.reset();
  });

  /** nextCursorが尽きるまでページを辿り、各ページのjobId列を返す。 */
  async function paginate(limit: number): Promise<string[][]> {
    const pages: string[][] = [];
    let cursor: JobsCursor | undefined;
    // 無限ループ検知のため十分大きい上限を置く。
    for (let i = 0; i < 50; i += 1) {
      const result = await listJobs("jobs-table", { limit, cursor });
      pages.push(result.items.map((item) => item.jobId));
      if (!result.nextCursor) {
        return pages;
      }
      // 実運用と同じくカーソルは一度エンコード/デコードを通す。
      cursor = decodeCursor(encodeCursor(result.nextCursor)) ?? undefined;
    }
    throw new Error("ページングが終了しなかった");
  }

  it("片方のストリームが極端に古い場合でも全件を欠落なく辿れる", async () => {
    // 新しい方に100件のdone、遥かに古い位置に1件のfailed。カーソル1個で
    // 全ストリームを絞り込む実装では、ページ末尾がfailed-oldで埋まってカーソルが
    // 2020年へ飛び、間のdoneが丸ごと欠落していた。
    const base = Date.parse("2026-07-30T00:00:00.000Z");
    const done = Array.from({ length: 100 }, (_, i) =>
      summary(`done-${String(i).padStart(3, "0")}`, new Date(base - i * 1000).toISOString(), "done"),
    );
    const failed = [summary("failed-old", "2020-01-01T00:00:00.000Z", "failed")];
    ddbMock.on(QueryCommand).callsFake(fakeQuery({ done, failed }));

    const pages = await paginate(20);
    const seen = pages.flat();

    expect(seen).toEqual([...done.map((i) => i.jobId), "failed-old"]);
    expect(new Set(seen).size).toBe(101);
    // 末尾に空ページが生えていない。
    expect(pages.at(-1)).not.toHaveLength(0);
  });

  it("limit=1でも1件ずつ全件辿れる", async () => {
    const done = [
      summary("done-1", "2026-07-30T00:00:03.000Z", "done"),
      summary("done-2", "2026-07-30T00:00:01.000Z", "done"),
    ];
    const failed = [summary("failed-1", "2026-07-30T00:00:02.000Z", "failed")];
    ddbMock.on(QueryCommand).callsFake(fakeQuery({ done, failed }));

    expect(await paginate(1)).toEqual([["done-1"], ["failed-1"], ["done-2"]]);
  });

  it("createdAtが同一のジョブが複数あっても欠落しない", async () => {
    const at = "2026-07-30T00:00:00.000Z";
    const done = ["a", "b", "c", "d"].map((suffix) => summary(`done-${suffix}`, at, "done"));
    const failed = [summary("failed-a", at, "failed")];
    ddbMock.on(QueryCommand).callsFake(fakeQuery({ done, failed }));

    const seen = (await paginate(2)).flat();

    expect(new Set(seen).size).toBe(5);
    expect([...seen].sort()).toEqual(["done-a", "done-b", "done-c", "done-d", "failed-a"]);
  });
});
