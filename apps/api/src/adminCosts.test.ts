import { beforeEach, describe, expect, it } from "vitest";
import { CloudWatchClient, GetMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { BYTES_PER_GB, CLOUDFRONT_FREE_TIER_GB_PER_MONTH } from "@sattori/shared";
import type { JobCostInput } from "@sattori/shared";
import { estimateCurrentMonthCostUsd, parseGranularity, summarizeCosts } from "./adminCosts.js";

const ddbMock = mockClient(DynamoDBDocumentClient);
const cloudwatchMock = mockClient(CloudWatchClient);

const NOW = new Date("2026-08-02T00:00:00.000Z");

function job(overrides: Partial<JobCostInput> = {}): JobCostInput {
  return {
    status: "done",
    game: "th07",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:36:00.000Z",
    launchedAt: "2026-08-01T00:00:00.000Z",
    doneAt: "2026-08-01T00:36:00.000Z",
    instanceId: "i-1",
    workerKind: null,
    instanceType: "c7i.xlarge",
    spotPricePerHour: 0.06,
    outputPath: "outputs/a/original.mp4",
    outputPath720p: "outputs/a/720p.mp4",
    outputBytes: 700 * 1024 * 1024,
    outputBytes720p: 1024 * 1024 * 1024,
    ...overrides,
  };
}

describe("parseGranularity", () => {
  it("未指定・不正な値は null", () => {
    expect(parseGranularity(undefined)).toBeNull();
    expect(parseGranularity("hourly")).toBeNull();
  });

  it("有効な粒度はそのまま返す", () => {
    expect(parseGranularity("daily")).toBe("daily");
    expect(parseGranularity("weekly")).toBe("weekly");
    expect(parseGranularity("monthly")).toBe("monthly");
  });
});

describe("自宅ワーカーのジョブの扱い（Issue #49）", () => {
  beforeEach(() => {
    ddbMock.reset();
  });

  const homeJob = () =>
    job({ workerKind: "home", instanceId: null, instanceType: null, spotPricePerHour: null });

  it("コストダッシュボードの集計でEC2系を積まない", async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [homeJob()] });

    const result = await summarizeCosts("jobs", { granularity: "monthly", limit: 12, now: NOW });
    const bucket = result.buckets[0]!;

    expect(bucket.jobCount).toBe(1);
    expect(bucket.homeWorkerJobCount).toBe(1);
    expect(bucket.billedSeconds).toBe(0);
    expect(bucket.breakdown.ec2Spot).toBe(0);
    expect(bucket.breakdown.ebs).toBe(0);
    expect(bucket.breakdown.publicIpv4).toBe(0);
    // S3保管料は自宅ワーカーでも実際に発生するので計上する。
    expect(bucket.breakdown.s3Storage).toBeGreaterThan(0);
  });

  it("EC2ジョブと混在しても、EC2系の合計は EC2 ジョブのぶんだけになる", async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [job(), homeJob()] });

    const mixed = await summarizeCosts("jobs", { granularity: "monthly", limit: 12, now: NOW });
    ddbMock.reset();
    ddbMock.on(ScanCommand).resolves({ Items: [job()] });
    const ec2Only = await summarizeCosts("jobs", { granularity: "monthly", limit: 12, now: NOW });

    expect(mixed.buckets[0]!.jobCount).toBe(2);
    expect(mixed.buckets[0]!.homeWorkerJobCount).toBe(1);
    expect(mixed.buckets[0]!.breakdown.ec2Spot).toBeCloseTo(
      ec2Only.buckets[0]!.breakdown.ec2Spot,
      10,
    );
    expect(mixed.buckets[0]!.billedSeconds).toBe(ec2Only.buckets[0]!.billedSeconds);
  });

  it("月間コストガードの当月推定にもEC2費用を含めない", async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [homeJob()] });
    const homeOnly = await estimateCurrentMonthCostUsd("jobs", NOW);

    ddbMock.reset();
    ddbMock.on(ScanCommand).resolves({ Items: [job()] });
    const ec2Only = await estimateCurrentMonthCostUsd("jobs", NOW);

    // 同じ出力サイズなのでS3/miscは同額。差はまるごとEC2系の有無になる。
    expect(homeOnly).toBeLessThan(ec2Only);
    expect(ec2Only - homeOnly).toBeCloseTo(0.06 * 0.6 + (30 * 0.088 * (0.6 / 730)) + 0.005 * 0.6, 6);
  });
});

describe("summarizeCosts", () => {
  beforeEach(() => {
    ddbMock.reset();
    cloudwatchMock.reset();
  });

  it("Scanのページングを追い切って全件集計する", async () => {
    ddbMock
      .on(ScanCommand)
      .resolvesOnce({ Items: [job()], LastEvaluatedKey: { jobId: "a" } })
      .resolvesOnce({ Items: [job()] });

    const result = await summarizeCosts("jobs", { granularity: "daily", limit: 30, now: NOW });

    expect(ddbMock.commandCalls(ScanCommand)).toHaveLength(2);
    expect(result.totalJobCount).toBe(2);
    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0]?.jobCount).toBe(2);
  });

  it("launchedAt を基準に日次バケットへ振り分け、新しい順に返す", async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [
        job({ launchedAt: "2026-07-30T10:00:00.000Z", doneAt: "2026-07-30T10:30:00.000Z" }),
        job({ launchedAt: "2026-08-01T10:00:00.000Z", doneAt: "2026-08-01T10:30:00.000Z" }),
        job({ launchedAt: "2026-08-01T20:00:00.000Z", doneAt: "2026-08-01T20:30:00.000Z" }),
      ],
    });

    const result = await summarizeCosts("jobs", { granularity: "daily", limit: 30, now: NOW });

    expect(result.buckets.map((b) => b.key)).toEqual(["2026-08-01", "2026-07-30"]);
    expect(result.buckets[0]?.jobCount).toBe(2);
    expect(result.buckets[1]?.jobCount).toBe(1);
    expect(result.jobCount).toBe(3);
  });

  it("launchedAt が無いジョブは createdAt でバケットを決める", async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [job({ launchedAt: null, createdAt: "2026-06-15T00:00:00.000Z" })],
    });

    const result = await summarizeCosts("jobs", { granularity: "monthly", limit: 30, now: NOW });

    expect(result.buckets.map((b) => b.key)).toEqual(["2026-06"]);
    expect(result.quality.assumedDurationJobs).toBe(1);
  });

  it("done/failed の内訳とコストの合計を積む", async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [
        job(),
        job({ status: "failed", doneAt: null, updatedAt: "2026-08-01T00:12:00.000Z" }),
        job({ status: "recording", doneAt: null }),
      ],
    });

    const result = await summarizeCosts("jobs", { granularity: "monthly", limit: 30, now: NOW });

    const bucket = result.buckets[0];
    expect(bucket?.key).toBe("2026-08");
    expect(bucket?.jobCount).toBe(3);
    expect(bucket?.doneCount).toBe(1);
    expect(bucket?.failedCount).toBe(1);
    expect(bucket?.totalUsd).toBeGreaterThan(0);
    expect(bucket?.storedBytes).toBe(3 * (700 * 1024 * 1024 + 1024 * 1024 * 1024));
  });

  it("limit を超えたバケットは切り落とし、品質カウンタは返したバケットぶんだけ数える", async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [
        job({ launchedAt: "2026-08-01T00:00:00.000Z" }),
        // 古い方は旧ジョブ（launchedAt/spotPrice/サイズ無し）。切り落とされるので
        // quality には計上されない。
        job({
          launchedAt: null,
          createdAt: "2026-07-01T00:00:00.000Z",
          spotPricePerHour: null,
          outputBytes: null,
          outputBytes720p: null,
        }),
      ],
    });

    const result = await summarizeCosts("jobs", { granularity: "monthly", limit: 1, now: NOW });

    expect(result.buckets.map((b) => b.key)).toEqual(["2026-08"]);
    expect(result.jobCount).toBe(1);
    expect(result.totalJobCount).toBe(2);
    expect(result.quality).toEqual({
      assumedDurationJobs: 0,
      fallbackSpotPriceJobs: 0,
      unknownOutputSizeJobs: 0,
    });
  });

  it("フォールバックを使ったジョブを品質カウンタに数える", async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [
        job({ launchedAt: null, spotPricePerHour: null, outputBytes: null, outputBytes720p: null }),
      ],
    });

    const result = await summarizeCosts("jobs", { granularity: "monthly", limit: 30, now: NOW });

    expect(result.quality).toEqual({
      assumedDurationJobs: 1,
      fallbackSpotPriceJobs: 1,
      unknownOutputSizeJobs: 1,
    });
  });

  it("CloudFrontは粒度によらず月次で集計し、無料枠超過分だけ課金する", async () => {
    // 1ジョブあたり720p版1GiBの配信とみなす。無料枠(1TB/月)を100GB超える件数を作る。
    const jobs = Array.from({ length: CLOUDFRONT_FREE_TIER_GB_PER_MONTH + 100 }, () =>
      job({ outputBytes720p: BYTES_PER_GB }),
    );
    ddbMock.on(ScanCommand).resolves({ Items: jobs });

    const result = await summarizeCosts("jobs", { granularity: "daily", limit: 30, now: NOW });

    expect(result.cloudFront).toHaveLength(1);
    expect(result.cloudFront[0]?.month).toBe("2026-08");
    expect(result.cloudFront[0]?.overageGb).toBeCloseTo(100, 6);
    expect(result.cloudFront[0]?.usd).toBeCloseTo(100 * 0.085, 6);
  });

  it("cloudFrontDistributionIdを渡さなければCloudWatchを呼ばず、実測値はnullになる（Issue #163）", async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [job()] });

    const result = await summarizeCosts("jobs", { granularity: "monthly", limit: 30, now: NOW });

    expect(cloudwatchMock.commandCalls(GetMetricDataCommand)).toHaveLength(0);
    expect(result.cloudFront[0]?.measuredDeliveryBytes).toBeNull();
  });

  it("cloudFrontDistributionIdを渡すとCloudWatchのBytesDownloadedを月ごとに合算してmeasuredDeliveryBytesへ入れる（Issue #163）", async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [job()] });
    cloudwatchMock.on(GetMetricDataCommand).resolves({
      MetricDataResults: [
        {
          Id: "bytesDownloaded",
          Timestamps: [new Date("2026-08-01T00:00:00.000Z"), new Date("2026-08-02T00:00:00.000Z")],
          Values: [10 * BYTES_PER_GB, 5 * BYTES_PER_GB],
        },
      ],
    });

    const result = await summarizeCosts("jobs", {
      granularity: "monthly",
      limit: 30,
      now: NOW,
      cloudFrontDistributionId: "E1234567890ABC",
    });

    const calls = cloudwatchMock.commandCalls(GetMetricDataCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0]!.args[0].input;
    expect(input.MetricDataQueries?.[0]?.MetricStat?.Metric?.Dimensions).toEqual([
      { Name: "DistributionId", Value: "E1234567890ABC" },
      { Name: "Region", Value: "Global" },
    ]);
    expect(input.StartTime).toEqual(new Date("2026-08-01T00:00:00.000Z"));
    expect(input.EndTime).toEqual(NOW);
    expect(result.cloudFront[0]?.measuredDeliveryBytes).toBeCloseTo(15 * BYTES_PER_GB, 6);
  });

  it("CloudWatch呼び出しが失敗しても集計自体は壊れず、実測値だけnullになる（Issue #163）", async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [job()] });
    cloudwatchMock.on(GetMetricDataCommand).rejects(new Error("AccessDenied"));

    const result = await summarizeCosts("jobs", {
      granularity: "monthly",
      limit: 30,
      now: NOW,
      cloudFrontDistributionId: "E1234567890ABC",
    });

    expect(result.cloudFront[0]?.deliveryBytes).toBeGreaterThan(0);
    expect(result.cloudFront[0]?.measuredDeliveryBytes).toBeNull();
  });

  it("時刻が壊れているレコードは集計から除外する（例外にしない）", async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [job({ launchedAt: null, createdAt: "not-a-date" }), job()],
    });

    const result = await summarizeCosts("jobs", { granularity: "monthly", limit: 30, now: NOW });

    expect(result.totalJobCount).toBe(2);
    expect(result.jobCount).toBe(1);
  });

  it("属性が欠落した旧レコードでも落ちない", async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [
        {
          status: "done",
          game: "th06",
          createdAt: "2026-05-01T00:00:00.000Z",
          updatedAt: "2026-05-01T00:30:00.000Z",
        },
      ],
    });

    const result = await summarizeCosts("jobs", { granularity: "monthly", limit: 30, now: NOW });

    expect(result.buckets[0]?.key).toBe("2026-05");
    expect(result.buckets[0]?.totalUsd).toBeGreaterThan(0);
  });
});

describe("estimateCurrentMonthCostUsd", () => {
  beforeEach(() => {
    ddbMock.reset();
  });

  it("当月のジョブのbreakdown合計＋CloudFront超過分を返す(月間コストガード、Issue #14)", async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [job()] });

    const total = await estimateCurrentMonthCostUsd("jobs", NOW);

    const monthly = await summarizeCosts("jobs", { granularity: "monthly", limit: 1, now: NOW });
    expect(total).toBeCloseTo(
      (monthly.buckets[0]?.totalUsd ?? 0) + (monthly.cloudFront[0]?.usd ?? 0),
      10,
    );
    expect(total).toBeGreaterThan(0);
  });

  it("当月にジョブが無ければ0を返す", async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [job({ createdAt: "2026-06-01T00:00:00.000Z", launchedAt: "2026-06-01T00:00:00.000Z" })],
    });

    const total = await estimateCurrentMonthCostUsd("jobs", NOW);
    expect(total).toBe(0);
  });
});
