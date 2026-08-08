import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";

const ddbMock = mockClient(DynamoDBDocumentClient);

describe("costGuard", () => {
  beforeEach(() => {
    ddbMock.reset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("当月コストはTTL内は再計算せずキャッシュを返す(全件Scanの濫用対策、Issue #14)", async () => {
    vi.useFakeTimers();
    ddbMock.on(ScanCommand).resolves({ Items: [] });
    const { getCachedMonthlyCostUsd, resetCostGuardCache, COST_GUARD_CACHE_TTL_MS } =
      await import("./costGuard.js");
    resetCostGuardCache();

    expect(await getCachedMonthlyCostUsd("jobs")).toBe(0);
    expect(await getCachedMonthlyCostUsd("jobs")).toBe(0);
    expect(ddbMock.commandCalls(ScanCommand)).toHaveLength(1);

    // TTL経過後は再計算する
    vi.advanceTimersByTime(COST_GUARD_CACHE_TTL_MS + 1);
    expect(await getCachedMonthlyCostUsd("jobs")).toBe(0);
    expect(ddbMock.commandCalls(ScanCommand)).toHaveLength(2);
  });
});
