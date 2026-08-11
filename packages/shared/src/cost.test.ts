import { describe, expect, it } from "vitest";
import {
  addCostBreakdown,
  costBucketKey,
  CLOUDFRONT_FREE_TIER_GB_PER_MONTH,
  BYTES_PER_GB,
  emptyCostBreakdown,
  estimateCloudFrontCost,
  estimateJobCost,
  FALLBACK_BILLED_HOURS,
  FALLBACK_SPOT_PRICE_USD_PER_HOUR,
  MISC_USD_PER_JOB,
  sumCostBreakdown,
  usdToJpy,
  USD_TO_JPY_RATE,
} from "./cost.js";
import type { JobCostInput } from "./cost.js";

function makeJob(overrides: Partial<JobCostInput> = {}): JobCostInput {
  return {
    status: "done",
    game: "th07",
    workerKind: "ec2",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:36:00.000Z",
    launchedAt: "2026-08-01T00:00:00.000Z",
    doneAt: "2026-08-01T00:36:00.000Z",
    instanceId: "i-0123456789abcdef0",
    instanceType: "c7i.xlarge",
    spotPricePerHour: 0.06,
    outputPath: "outputs/job/original.mp4",
    outputPath720p: "outputs/job/720p.mp4",
    outputBytes: 694 * 1024 * 1024,
    outputBytes720p: 1036 * 1024 * 1024,
    ...overrides,
  };
}

describe("estimateJobCost（自宅ワーカー、Issue #49）", () => {
  it("EC2/EBS/IPv4は0で計上する（インスタンスを1台も起動していないため）", () => {
    const estimate = estimateJobCost(
      makeJob({ workerKind: "home", instanceId: null, instanceType: null, spotPricePerHour: null }),
      new Date("2026-08-02T00:00:00.000Z"),
    );

    expect(estimate.billedSeconds).toBe(0);
    expect(estimate.billedDurationSource).toBe("home-worker");
    expect(estimate.breakdown.ec2Spot).toBe(0);
    expect(estimate.breakdown.ebs).toBe(0);
    expect(estimate.breakdown.publicIpv4).toBe(0);
  });

  it("S3保管料とmiscは計上する（自宅で録画してもAWS側に実際に発生するため）", () => {
    const estimate = estimateJobCost(
      makeJob({ workerKind: "home" }),
      new Date("2026-08-02T00:00:00.000Z"),
    );

    expect(estimate.breakdown.s3Storage).toBeGreaterThan(0);
    expect(estimate.breakdown.misc).toBe(MISC_USD_PER_JOB);
    // CloudFrontの配信量も引き続き見積もる（無料枠の消化はワーカー種別に依らない）。
    expect(estimate.deliveryBytes).toBeGreaterThan(0);
  });

  it("実行中でもEC2コストは積み上がらない（launchedAtの有無に関わらず0）", () => {
    const estimate = estimateJobCost(
      makeJob({ workerKind: "home", status: "recording", doneAt: null }),
      new Date("2026-08-02T00:00:00.000Z"),
    );

    expect(estimate.billedSeconds).toBe(0);
    expect(estimate.billedDurationSource).toBe("home-worker");
  });
});

describe("estimateJobCost", () => {
  it("launchedAt〜doneAt を課金対象時間として EC2 コストを積む", () => {
    const estimate = estimateJobCost(makeJob(), new Date("2026-08-02T00:00:00.000Z"));

    expect(estimate.billedSeconds).toBe(36 * 60);
    expect(estimate.billedDurationSource).toBe("measured");
    expect(estimate.spotPriceSource).toBe("recorded");
    expect(estimate.breakdown.ec2Spot).toBeCloseTo(0.06 * 0.6, 10);
    expect(estimate.breakdown.publicIpv4).toBeCloseTo(0.005 * 0.6, 10);
    expect(estimate.breakdown.misc).toBe(MISC_USD_PER_JOB);
    expect(estimate.totalUsd).toBeCloseTo(sumCostBreakdown(estimate.breakdown), 10);
  });

  it("実行中のジョブは現在時刻までを課金対象時間にする", () => {
    const estimate = estimateJobCost(
      makeJob({ status: "recording", doneAt: null }),
      new Date("2026-08-01T00:10:00.000Z"),
    );

    expect(estimate.billedSeconds).toBe(600);
    expect(estimate.billedDurationSource).toBe("running");
  });

  it("失敗ジョブは doneAt が無いので updatedAt を終了時刻にする", () => {
    const estimate = estimateJobCost(
      makeJob({ status: "failed", doneAt: null, updatedAt: "2026-08-01T00:12:00.000Z" }),
      new Date("2026-08-02T00:00:00.000Z"),
    );

    expect(estimate.billedSeconds).toBe(12 * 60);
    expect(estimate.billedDurationSource).toBe("measured");
  });

  it("launchedAt が無い旧ジョブはフォールバックの稼働時間で代用する", () => {
    const estimate = estimateJobCost(
      makeJob({ launchedAt: null }),
      new Date("2026-08-02T00:00:00.000Z"),
    );

    expect(estimate.billedDurationSource).toBe("assumed");
    expect(estimate.billedSeconds).toBeCloseTo(FALLBACK_BILLED_HOURS * 3600, 6);
  });

  it("EC2 が一度も起動していないジョブは EC2 系のコストを 0 にする", () => {
    const estimate = estimateJobCost(
      makeJob({
        status: "pending",
        launchedAt: null,
        doneAt: null,
        instanceId: null,
        instanceType: null,
        spotPricePerHour: null,
        outputPath: null,
        outputPath720p: null,
        outputBytes: null,
        outputBytes720p: null,
      }),
      new Date("2026-08-02T00:00:00.000Z"),
    );

    expect(estimate.billedDurationSource).toBe("not-launched");
    expect(estimate.billedSeconds).toBe(0);
    expect(estimate.breakdown.ec2Spot).toBe(0);
    expect(estimate.breakdown.ebs).toBe(0);
    expect(estimate.breakdown.publicIpv4).toBe(0);
    expect(estimate.breakdown.s3Storage).toBe(0);
    // 未起動でも Lambda/SES/DynamoDB は動いているので misc だけが残る。
    expect(estimate.totalUsd).toBe(MISC_USD_PER_JOB);
  });

  it("Spot単価が未記録ならインスタンスタイプのサイズ帯から補完する", () => {
    const estimate = estimateJobCost(
      makeJob({ spotPricePerHour: null, instanceType: "c7i.2xlarge" }),
      new Date("2026-08-02T00:00:00.000Z"),
    );

    expect(estimate.spotPriceSource).toBe("fallback-instance-type");
    expect(estimate.spotPricePerHour).toBe(FALLBACK_SPOT_PRICE_USD_PER_HOUR["2xlarge"]);
  });

  it("th20の.4xlarge帯を.xlarge帯へ丸めない（約1/4で計上され月間コストガードが効かなくなる）", () => {
    const estimate = estimateJobCost(
      makeJob({ spotPricePerHour: null, instanceType: "c7i.4xlarge" }),
      new Date("2026-08-02T00:00:00.000Z"),
    );

    expect(estimate.spotPricePerHour).toBe(FALLBACK_SPOT_PRICE_USD_PER_HOUR["4xlarge"]);
  });

  it("インスタンスタイプも不明ならゲームからサイズ帯を推定する（th11は.2xlarge帯）", () => {
    const th11 = estimateJobCost(
      makeJob({ spotPricePerHour: null, instanceType: null, game: "th11" }),
      new Date("2026-08-02T00:00:00.000Z"),
    );
    const th07 = estimateJobCost(
      makeJob({ spotPricePerHour: null, instanceType: null, game: "th07" }),
      new Date("2026-08-02T00:00:00.000Z"),
    );

    const th20 = estimateJobCost(
      makeJob({ spotPricePerHour: null, instanceType: null, game: "th20" }),
      new Date("2026-08-02T00:00:00.000Z"),
    );

    expect(th11.spotPriceSource).toBe("fallback-game");
    expect(th11.spotPricePerHour).toBe(FALLBACK_SPOT_PRICE_USD_PER_HOUR["2xlarge"]);
    expect(th07.spotPricePerHour).toBe(FALLBACK_SPOT_PRICE_USD_PER_HOUR.xlarge);
    // `launching`（インスタンスタイプ記録前）や管理画面からの再実行で通る経路。
    expect(th20.spotPricePerHour).toBe(FALLBACK_SPOT_PRICE_USD_PER_HOUR["4xlarge"]);
  });

  it("配信量は720p版1回ぶん、保管量は両方の合計とする", () => {
    const estimate = estimateJobCost(makeJob(), new Date("2026-08-02T00:00:00.000Z"));

    expect(estimate.deliveryBytes).toBe(1036 * 1024 * 1024);
    expect(estimate.storedBytes).toBe((694 + 1036) * 1024 * 1024);
    expect(estimate.outputSizeUnknown).toBe(false);
    // 1.69GiB を 7日ぶん保管 → S3 Standard $0.023/GB-Mo の按分。
    expect(estimate.breakdown.s3Storage).toBeCloseTo(
      ((694 + 1036) / 1024) * 0.023 * ((7 * 24) / 730),
      10,
    );
  });

  it("出力があるのにサイズ未記録の旧ジョブは outputSizeUnknown を立てる", () => {
    const estimate = estimateJobCost(
      makeJob({ outputBytes: null, outputBytes720p: null }),
      new Date("2026-08-02T00:00:00.000Z"),
    );

    expect(estimate.outputSizeUnknown).toBe(true);
    expect(estimate.breakdown.s3Storage).toBe(0);
    expect(estimate.deliveryBytes).toBe(0);
  });

  it("時刻が逆転していても負の稼働時間にはしない", () => {
    const estimate = estimateJobCost(
      makeJob({ launchedAt: "2026-08-01T01:00:00.000Z", doneAt: "2026-08-01T00:00:00.000Z" }),
      new Date("2026-08-02T00:00:00.000Z"),
    );

    expect(estimate.billedSeconds).toBe(0);
  });
});

describe("costBucketKey", () => {
  it("daily は UTC の日付", () => {
    expect(costBucketKey(new Date("2026-08-02T23:30:00.000Z"), "daily")).toBe("2026-08-02");
  });

  it("monthly は UTC の年月", () => {
    expect(costBucketKey(new Date("2026-08-02T23:30:00.000Z"), "monthly")).toBe("2026-08");
  });

  it("weekly はその週の月曜日", () => {
    // 2026-08-02 は日曜日 → 直前の月曜は 2026-07-27。
    expect(costBucketKey(new Date("2026-08-02T12:00:00.000Z"), "weekly")).toBe("2026-07-27");
    expect(costBucketKey(new Date("2026-07-27T00:00:00.000Z"), "weekly")).toBe("2026-07-27");
    expect(costBucketKey(new Date("2026-08-03T00:00:00.000Z"), "weekly")).toBe("2026-08-03");
  });
});

describe("estimateCloudFrontCost", () => {
  it("無料枠内なら課金しない", () => {
    const result = estimateCloudFrontCost(500 * BYTES_PER_GB);
    expect(result.overageGb).toBe(0);
    expect(result.usd).toBe(0);
  });

  it("無料枠を超えた分にだけ単価を掛ける", () => {
    const result = estimateCloudFrontCost((CLOUDFRONT_FREE_TIER_GB_PER_MONTH + 100) * BYTES_PER_GB);
    expect(result.overageGb).toBeCloseTo(100, 6);
    expect(result.usd).toBeCloseTo(100 * 0.085, 6);
  });
});

describe("addCostBreakdown", () => {
  it("項目ごとに加算する", () => {
    const a = { ec2Spot: 1, ebs: 2, publicIpv4: 3, s3Storage: 4, misc: 5 };
    expect(addCostBreakdown(emptyCostBreakdown(), a)).toEqual(a);
    expect(sumCostBreakdown(addCostBreakdown(a, a))).toBe(30);
  });
});

describe("usdToJpy", () => {
  it("固定レートで円に換算する", () => {
    expect(usdToJpy(1)).toBeCloseTo(USD_TO_JPY_RATE, 10);
    expect(usdToJpy(0.05)).toBeCloseTo(0.05 * USD_TO_JPY_RATE, 10);
    expect(usdToJpy(0)).toBe(0);
  });
});
