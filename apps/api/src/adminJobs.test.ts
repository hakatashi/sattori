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
    const cursor = { createdAt: "2026-07-30T00:00:00.000Z", jobId: "job-1" };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it("不正なカーソルはnullを返す", () => {
    expect(decodeCursor("not-base64url!!!")).toBeNull();
    expect(decodeCursor(Buffer.from("no-separator", "utf8").toString("base64url"))).toBeNull();
    // createdAtとして解釈できない
    expect(decodeCursor(Buffer.from("invalid-date|job-1", "utf8").toString("base64url"))).toBeNull();
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

  it("limit件で打ち切り、nextCursorに最後のアイテムの情報を入れる", async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        summary("job-3", "2026-07-30T00:00:03.000Z", "done"),
        summary("job-2", "2026-07-30T00:00:02.000Z", "done"),
        summary("job-1", "2026-07-30T00:00:01.000Z", "done"),
      ],
    });

    const result = await listJobs("jobs-table", { status: "done", limit: 2 });

    expect(result.items.map((i) => i.jobId)).toEqual(["job-3", "job-2"]);
    expect(result.nextCursor).toEqual({ createdAt: "2026-07-30T00:00:02.000Z", jobId: "job-2" });
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

  it("カーソル指定時はcreatedAt <= カーソル値で絞り込み、カーソル自体は結果から除外する", async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        summary("job-2", "2026-07-30T00:00:02.000Z", "done"),
        summary("job-1", "2026-07-30T00:00:01.000Z", "done"),
      ],
    });

    const result = await listJobs("jobs-table", {
      status: "done",
      limit: 20,
      cursor: { createdAt: "2026-07-30T00:00:02.000Z", jobId: "job-2" },
    });

    expect(result.items.map((i) => i.jobId)).toEqual(["job-1"]);
    const calls = ddbMock.commandCalls(QueryCommand);
    expect(calls[0]?.args[0].input).toMatchObject({
      KeyConditionExpression: "#status = :status AND createdAt <= :cursorCreatedAt",
      ExpressionAttributeValues: { ":status": "done", ":cursorCreatedAt": "2026-07-30T00:00:02.000Z" },
    });
  });
});
