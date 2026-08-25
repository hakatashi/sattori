import { beforeEach, describe, expect, it, vi } from "vitest";
import { CloudWatchClient, GetMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { mockClient } from "aws-sdk-client-mock";
import { fetchMeasuredCloudFrontBytesByMonth } from "./cloudfrontMetrics.js";

const cloudwatchMock = mockClient(CloudWatchClient);

const SINCE = new Date("2026-07-01T00:00:00.000Z");
const NOW = new Date("2026-08-02T00:00:00.000Z");

describe("fetchMeasuredCloudFrontBytesByMonth", () => {
  beforeEach(() => {
    cloudwatchMock.reset();
  });

  it("日次のSumを月ごとに合算する（暦月をまたぐデータポイントを正しく振り分ける）", async () => {
    cloudwatchMock.on(GetMetricDataCommand).resolves({
      MetricDataResults: [
        {
          Id: "bytesDownloaded",
          Timestamps: [
            new Date("2026-07-31T00:00:00.000Z"),
            new Date("2026-08-01T00:00:00.000Z"),
            new Date("2026-08-02T00:00:00.000Z"),
          ],
          Values: [100, 200, 300],
        },
      ],
    });

    const result = await fetchMeasuredCloudFrontBytesByMonth("E123", SINCE, NOW);

    expect(result.get("2026-07")).toBe(100);
    expect(result.get("2026-08")).toBe(500);
  });

  it("us-east-1のクライアントでDistributionId/Region=Globalディメンションを指定する", async () => {
    cloudwatchMock.on(GetMetricDataCommand).resolves({ MetricDataResults: [] });

    await fetchMeasuredCloudFrontBytesByMonth("E123", SINCE, NOW);

    const call = cloudwatchMock.commandCalls(GetMetricDataCommand)[0]!;
    const query = call.args[0].input.MetricDataQueries?.[0];
    expect(query?.MetricStat?.Metric?.Namespace).toBe("AWS/CloudFront");
    expect(query?.MetricStat?.Metric?.MetricName).toBe("BytesDownloaded");
    expect(query?.MetricStat?.Metric?.Dimensions).toEqual([
      { Name: "DistributionId", Value: "E123" },
      { Name: "Region", Value: "Global" },
    ]);
    expect(query?.MetricStat?.Stat).toBe("Sum");
  });

  it("結果が空でも空のMapを返す", async () => {
    cloudwatchMock.on(GetMetricDataCommand).resolves({ MetricDataResults: [] });

    const result = await fetchMeasuredCloudFrontBytesByMonth("E123", SINCE, NOW);

    expect(result.size).toBe(0);
  });

  it("呼び出しが例外を投げても握りつぶして空のMapを返す（付随データが本体を壊さない方針）", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    cloudwatchMock.on(GetMetricDataCommand).rejects(new Error("AccessDenied"));

    const result = await fetchMeasuredCloudFrontBytesByMonth("E123", SINCE, NOW);

    expect(result.size).toBe(0);
    errorSpy.mockRestore();
  });
});
