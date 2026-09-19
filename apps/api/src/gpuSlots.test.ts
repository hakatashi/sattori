import { beforeEach, describe, expect, it } from "vitest";
import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import {
  acquireGpuSlot,
  createCompensatingGpuLease,
  getGpuLease,
  listGpuSlots,
  releaseGpuSlot,
  repairGpuLeaseVcpu,
  shrinkGpuLease,
} from "./gpuSlots.js";

const ddbMock = mockClient(DynamoDBDocumentClient);

beforeEach(() => {
  ddbMock.reset();
});

const TABLE = "gpu-slots";
const now = new Date("2026-09-19T00:00:00.000Z");
const finish = new Date("2026-09-19T00:30:00.000Z");

function canceledException(reasons: Array<{ Code?: string }>) {
  return new TransactionCanceledException({
    message: "canceled",
    $metadata: {},
    CancellationReasons: reasons,
  });
}

describe("acquireGpuSlot", () => {
  it("空きがあれば8vCPUを確保する", async () => {
    ddbMock.on(TransactWriteCommand).resolves({});

    const result = await acquireGpuSlot(TABLE, "job-1", 8, now, finish);

    expect(result).toEqual({
      kind: "acquired",
      lease: {
        jobId: "job-1",
        vcpu: 8,
        acquiredAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 180 * 60 * 1000).toISOString(),
        expectedFinishAt: finish.toISOString(),
      },
    });
    const input = ddbMock.commandCalls(TransactWriteCommand)[0]?.args[0].input;
    const updateItem = input?.TransactItems?.[1]?.Update;
    expect(updateItem?.ConditionExpression).toBe(
      "attribute_not_exists(usedVcpu) OR usedVcpu <= :limit",
    );
    expect(updateItem?.ExpressionAttributeValues?.[":limit"]).toBe(0); // QUOTA(8) - reserve(8)
  });

  it("残4vCPUなら4vCPUのみ確保できる", async () => {
    ddbMock.on(TransactWriteCommand).resolves({});
    const result = await acquireGpuSlot(TABLE, "job-1", 4, now, finish);
    expect(result.kind).toBe("acquired");
    const updateItem = ddbMock.commandCalls(TransactWriteCommand)[0]?.args[0].input.TransactItems?.[1]
      ?.Update;
    expect(updateItem?.ExpressionAttributeValues?.[":limit"]).toBe(4); // QUOTA(8) - reserve(4)
  });

  it("カウンタの条件不成立(空き容量不足)は no_capacity を返す", async () => {
    ddbMock.on(TransactWriteCommand).rejects(canceledException([{ Code: "None" }, { Code: "ConditionalCheckFailed" }]));

    const result = await acquireGpuSlot(TABLE, "job-1", 8, now, finish);
    expect(result).toEqual({ kind: "no_capacity" });
  });

  it("同一jobIdへの再取得は冪等(既存リースを期限延長してacquired扱い)", async () => {
    ddbMock
      .on(TransactWriteCommand)
      .rejects(canceledException([{ Code: "ConditionalCheckFailed" }, { Code: "None" }]));
    ddbMock.on(UpdateCommand).resolves({
      Attributes: {
        slotKey: "gpu",
        itemKey: "job#job-1",
        jobId: "job-1",
        vcpu: 8,
        acquiredAt: "2026-09-18T23:00:00.000Z",
        expiresAt: new Date(now.getTime() + 180 * 60 * 1000).toISOString(),
        expectedFinishAt: finish.toISOString(),
      },
    });

    const result = await acquireGpuSlot(TABLE, "job-1", 8, now, finish);
    expect(result.kind).toBe("acquired");
    if (result.kind === "acquired") {
      expect(result.lease.jobId).toBe("job-1");
      expect(result.lease.acquiredAt).toBe("2026-09-18T23:00:00.000Z");
    }
  });

  it("期限延長時にリースが既に消えていたら no_capacity を返す", async () => {
    ddbMock
      .on(TransactWriteCommand)
      .rejects(canceledException([{ Code: "ConditionalCheckFailed" }, { Code: "None" }]));
    ddbMock.on(UpdateCommand).resolves({});

    const result = await acquireGpuSlot(TABLE, "job-1", 8, now, finish);
    expect(result).toEqual({ kind: "no_capacity" });
  });

  it("TransactionCanceledException以外は再送出する", async () => {
    ddbMock.on(TransactWriteCommand).rejects(new Error("network error"));
    await expect(acquireGpuSlot(TABLE, "job-1", 8, now, finish)).rejects.toThrow("network error");
  });

  it("期限延長中の予期しないエラーは再送出する", async () => {
    ddbMock
      .on(TransactWriteCommand)
      .rejects(canceledException([{ Code: "ConditionalCheckFailed" }, { Code: "None" }]));
    ddbMock.on(UpdateCommand).rejects(new Error("throttled"));
    await expect(acquireGpuSlot(TABLE, "job-1", 8, now, finish)).rejects.toThrow("throttled");
  });
});

describe("getGpuLease", () => {
  it("リースが存在すればそのまま返す", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        slotKey: "gpu",
        itemKey: "job#job-1",
        jobId: "job-1",
        vcpu: 4,
        acquiredAt: "2026-09-19T00:00:00.000Z",
        expiresAt: "2026-09-19T03:00:00.000Z",
        expectedFinishAt: "2026-09-19T00:30:00.000Z",
        instanceType: "g6f.xlarge",
        instanceId: "i-1",
      },
    });
    const lease = await getGpuLease(TABLE, "job-1");
    expect(lease).toMatchObject({ jobId: "job-1", vcpu: 4, instanceType: "g6f.xlarge" });
    expect(ddbMock.commandCalls(GetCommand)[0]?.args[0].input.ConsistentRead).toBe(true);
  });

  it("存在しなければnull", async () => {
    ddbMock.on(GetCommand).resolves({});
    await expect(getGpuLease(TABLE, "job-1")).resolves.toBeNull();
  });
});

describe("shrinkGpuLease", () => {
  it("旧vCPUを条件にvcpuを更新しカウンタを差分だけ減らす", async () => {
    ddbMock.on(TransactWriteCommand).resolves({});
    await shrinkGpuLease(TABLE, "job-1", 8, 4, "g6f.xlarge", "i-1");

    const input = ddbMock.commandCalls(TransactWriteCommand)[0]?.args[0].input;
    const leaseUpdate = input?.TransactItems?.[0]?.Update;
    expect(leaseUpdate?.ConditionExpression).toBe("attribute_exists(itemKey) AND vcpu = :old");
    expect(leaseUpdate?.ExpressionAttributeValues?.[":old"]).toBe(8);
    expect(leaseUpdate?.ExpressionAttributeValues?.[":new"]).toBe(4);
    const quotaUpdate = input?.TransactItems?.[1]?.Update;
    expect(quotaUpdate?.ExpressionAttributeValues?.[":delta"]).toBe(4);
  });

  it("縮小しない(newVcpu>=oldVcpu)場合は何もしない", async () => {
    await shrinkGpuLease(TABLE, "job-1", 4, 4, "g6f.xlarge", "i-1");
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it("条件不一致は例外を投げずログのみに残す(縮小漏れはリコンサイラが補正する)", async () => {
    ddbMock.on(TransactWriteCommand).rejects(canceledException([{ Code: "ConditionalCheckFailed" }]));
    await expect(shrinkGpuLease(TABLE, "job-1", 8, 4, "g6f.xlarge", "i-1")).resolves.toBeUndefined();
  });
});

describe("releaseGpuSlot", () => {
  it("リースが存在すれば削除しカウンタを減算する", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        slotKey: "gpu",
        itemKey: "job#job-1",
        jobId: "job-1",
        vcpu: 4,
        acquiredAt: "x",
        expiresAt: "y",
        expectedFinishAt: "z",
      },
    });
    ddbMock.on(TransactWriteCommand).resolves({});

    await releaseGpuSlot(TABLE, "job-1");

    const input = ddbMock.commandCalls(TransactWriteCommand)[0]?.args[0].input;
    expect(input?.TransactItems?.[0]?.Delete?.ExpressionAttributeValues?.[":vcpu"]).toBe(4);
  });

  it("リースが存在しなければ何もせず成功する(冪等・非GPUジョブから呼んでも安全)", async () => {
    ddbMock.on(GetCommand).resolves({});
    await expect(releaseGpuSlot(TABLE, "job-1")).resolves.toBeUndefined();
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it("既に返却済み(TransactionCanceled)は冪等に成功扱いにする", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        slotKey: "gpu",
        itemKey: "job#job-1",
        jobId: "job-1",
        vcpu: 4,
        acquiredAt: "x",
        expiresAt: "y",
        expectedFinishAt: "z",
      },
    });
    ddbMock.on(TransactWriteCommand).rejects(canceledException([{ Code: "ConditionalCheckFailed" }]));
    await expect(releaseGpuSlot(TABLE, "job-1")).resolves.toBeUndefined();
  });

  it("予期しないエラーは再送出する", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        slotKey: "gpu",
        itemKey: "job#job-1",
        jobId: "job-1",
        vcpu: 4,
        acquiredAt: "x",
        expiresAt: "y",
        expectedFinishAt: "z",
      },
    });
    ddbMock.on(TransactWriteCommand).rejects(new Error("throttled"));
    await expect(releaseGpuSlot(TABLE, "job-1")).rejects.toThrow("throttled");
  });
});

describe("listGpuSlots", () => {
  it("カウンタと全リースをまとめて返す", async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        { slotKey: "gpu", itemKey: "#quota", usedVcpu: 8 },
        {
          slotKey: "gpu",
          itemKey: "job#job-1",
          jobId: "job-1",
          vcpu: 4,
          acquiredAt: "a",
          expiresAt: "b",
          expectedFinishAt: "c",
        },
        {
          slotKey: "gpu",
          itemKey: "job#job-2",
          jobId: "job-2",
          vcpu: 4,
          acquiredAt: "a",
          expiresAt: "b",
          expectedFinishAt: "c",
        },
      ],
    });

    const snapshot = await listGpuSlots(TABLE);
    expect(snapshot.usedVcpu).toBe(8);
    expect(snapshot.leases).toHaveLength(2);
    expect(ddbMock.commandCalls(QueryCommand)[0]?.args[0].input.ConsistentRead).toBe(true);
  });

  it("カウンタアイテムが無ければusedVcpuは0", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    await expect(listGpuSlots(TABLE)).resolves.toEqual({ usedVcpu: 0, leases: [] });
  });
});

describe("repairGpuLeaseVcpu(リコンサイラ専用)", () => {
  it("実測が大きい場合はvcpuを増やしカウンタも加算する", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { slotKey: "gpu", itemKey: "job#job-1", jobId: "job-1", vcpu: 4, acquiredAt: "a", expiresAt: "b", expectedFinishAt: "c" },
    });
    ddbMock.on(TransactWriteCommand).resolves({});

    await repairGpuLeaseVcpu(TABLE, "job-1", 8);

    const input = ddbMock.commandCalls(TransactWriteCommand)[0]?.args[0].input;
    expect(input?.TransactItems?.[0]?.Update?.ExpressionAttributeValues?.[":new"]).toBe(8);
    expect(input?.TransactItems?.[1]?.Update?.ExpressionAttributeValues?.[":delta"]).toBe(4);
  });

  it("実測が小さい場合はvcpuを減らしカウンタも減算する", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { slotKey: "gpu", itemKey: "job#job-1", jobId: "job-1", vcpu: 8, acquiredAt: "a", expiresAt: "b", expectedFinishAt: "c" },
    });
    ddbMock.on(TransactWriteCommand).resolves({});

    await repairGpuLeaseVcpu(TABLE, "job-1", 4);

    const input = ddbMock.commandCalls(TransactWriteCommand)[0]?.args[0].input;
    expect(input?.TransactItems?.[1]?.Update?.ExpressionAttributeValues?.[":delta"]).toBe(-4);
    expect(input?.TransactItems?.[1]?.Update?.ExpressionAttributeValues?.[":floor"]).toBe(4);
  });

  it("一致していれば何もしない", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { slotKey: "gpu", itemKey: "job#job-1", jobId: "job-1", vcpu: 4, acquiredAt: "a", expiresAt: "b", expectedFinishAt: "c" },
    });
    await repairGpuLeaseVcpu(TABLE, "job-1", 4);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it("リースが存在しなければ何もしない", async () => {
    ddbMock.on(GetCommand).resolves({});
    await repairGpuLeaseVcpu(TABLE, "job-1", 4);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it("条件不一致は例外を投げずログのみに残す", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { slotKey: "gpu", itemKey: "job#job-1", jobId: "job-1", vcpu: 4, acquiredAt: "a", expiresAt: "b", expectedFinishAt: "c" },
    });
    ddbMock.on(TransactWriteCommand).rejects(canceledException([{ Code: "ConditionalCheckFailed" }]));
    await expect(repairGpuLeaseVcpu(TABLE, "job-1", 8)).resolves.toBeUndefined();
  });
});

describe("createCompensatingGpuLease(リコンサイラ専用)", () => {
  it("リースを新規作成しカウンタへ加算する", async () => {
    ddbMock.on(TransactWriteCommand).resolves({});
    const acquiredAt = new Date("2026-09-19T00:00:00.000Z");

    await createCompensatingGpuLease(TABLE, "job-1", 4, acquiredAt);

    const input = ddbMock.commandCalls(TransactWriteCommand)[0]?.args[0].input;
    expect(input?.TransactItems?.[0]?.Put?.Item).toMatchObject({ jobId: "job-1", vcpu: 4 });
    expect(input?.TransactItems?.[1]?.Update?.ExpressionAttributeValues?.[":n"]).toBe(4);
  });

  it("既にリースが存在する場合は何もしない(冪等)", async () => {
    ddbMock.on(TransactWriteCommand).rejects(canceledException([{ Code: "ConditionalCheckFailed" }]));
    await expect(
      createCompensatingGpuLease(TABLE, "job-1", 4, new Date()),
    ).resolves.toBeUndefined();
  });

  it("予期しないエラーはログのみに残す(呼び出し元を落とさない)", async () => {
    ddbMock.on(TransactWriteCommand).rejects(new Error("throttled"));
    await expect(
      createCompensatingGpuLease(TABLE, "job-1", 4, new Date()),
    ).resolves.toBeUndefined();
  });
});
