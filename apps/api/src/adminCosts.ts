import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import {
  addCostBreakdown,
  COST_GRANULARITIES,
  costBucketKey,
  emptyCostBreakdown,
  estimateCloudFrontCost,
  estimateJobCost,
  sumCostBreakdown,
} from "@sattori/shared";
import type {
  AdminCloudFrontMonth,
  AdminCostBucket,
  AdminCostQuality,
  CostGranularity,
  JobCostInput,
} from "@sattori/shared";

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/**
 * 管理画面のコスト集計（Issue #60、`GET /admin/costs`）。
 *
 * **素朴な全件Scan + アプリ側集計**にしている。想定規模は月1000ジョブ（AGENTS.md）で、
 * `JobsTable`にはTTLも削除ポリシーも無いため1年運用しても1万件強にしかならない。
 * Athena等の分析基盤や、集計結果を別テーブルへ書き出す仕組みは明確に過剰で、
 * 「増えたら考える」ほうが総コストが低いという判断（Issue #60の設計メモ）。
 * `StatusCreatedAtIndex`を使わないのは、GSIのPKが`status`固定で全ステータス横断の
 * 期間クエリにならず、7本のQueryを束ねても結局全件読むことになるため。
 */

/** Scanで取得するのはコスト推定に必要なフィールドだけに絞る（通信量・メモリ削減）。 */
const COST_PROJECTION =
  "#status, game, workerKind, createdAt, updatedAt, launchedAt, doneAt, instanceId, instanceType, spotPricePerHour, outputPath, outputPath720p, outputBytes, outputBytes720p";
// "status"はDynamoDBの予約語。
const COST_EXPRESSION_ATTRIBUTE_NAMES = { "#status": "status" };

/** CloudFrontの無料枠判定を返す月数の上限（新しい順）。 */
export const CLOUDFRONT_MONTHS_LIMIT = 12;

export interface CostSummaryParams {
  granularity: CostGranularity;
  /** 返すバケット数（新しい順）。 */
  limit: number;
  /** 「現在時刻」。実行中ジョブの課金時間算出に使う（テストで固定するため注入する）。 */
  now: Date;
}

export interface CostSummaryResult {
  buckets: AdminCostBucket[];
  cloudFront: AdminCloudFrontMonth[];
  quality: AdminCostQuality;
  jobCount: number;
  totalJobCount: number;
}

/** 集計途中の可変バケット（`AdminCostBucket` + そのバケットぶんの品質カウンタ）。 */
interface MutableBucket extends AdminCostBucket {
  quality: AdminCostQuality;
}

function newBucket(key: string): MutableBucket {
  return {
    key,
    jobCount: 0,
    doneCount: 0,
    failedCount: 0,
    homeWorkerJobCount: 0,
    breakdown: emptyCostBreakdown(),
    totalUsd: 0,
    billedSeconds: 0,
    deliveryBytes: 0,
    storedBytes: 0,
    quality: {
      assumedDurationJobs: 0,
      fallbackSpotPriceJobs: 0,
      unknownOutputSizeJobs: 0,
    },
  };
}

/** クエリパラメータの`granularity`を検証する。不正・未指定なら null。 */
export function parseGranularity(raw: string | undefined): CostGranularity | null {
  if (raw === undefined) {
    return null;
  }
  return (COST_GRANULARITIES as readonly string[]).includes(raw) ? (raw as CostGranularity) : null;
}

/**
 * ジョブをどの期間バケットに入れるかの基準時刻。**コストが発生した時刻**を表したいので
 * `launchedAt`（EC2起動時刻）を優先し、無ければ`createdAt`で代用する
 * （`createdAt`はマジックリンク送信要求の時点なので、日付をまたいで起動された
 * ジョブでは1日ずれる。`launchedAt`を持たない旧ジョブでのみ起きる誤差）。
 */
function bucketTimeOf(job: JobCostInput): Date | null {
  const raw = job.launchedAt ?? job.createdAt;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : new Date(parsed);
}

/** `JobsTable`を全件Scanする（ページングを追い切る）。 */
async function scanAllJobs(table: string): Promise<JobCostInput[]> {
  const items: JobCostInput[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await client.send(
      new ScanCommand({
        TableName: table,
        ProjectionExpression: COST_PROJECTION,
        ExpressionAttributeNames: COST_EXPRESSION_ATTRIBUTE_NAMES,
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }),
    );
    items.push(...((result.Items as JobCostInput[] | undefined) ?? []));
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey !== undefined);
  return items;
}

/**
 * DynamoDBの数値は`lib-dynamodb`が`number`へ変換するが、旧レコードや属性欠落で
 * `undefined`が来ることがある（`ProjectionExpression`は存在しない属性を単に返さない）。
 * `JobCostInput`は`null`前提なので正規化する。
 */
function normalizeJob(item: JobCostInput): JobCostInput {
  return {
    status: item.status,
    game: item.game,
    workerKind: item.workerKind ?? null,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    launchedAt: item.launchedAt ?? null,
    doneAt: item.doneAt ?? null,
    instanceId: item.instanceId ?? null,
    instanceType: item.instanceType ?? null,
    spotPricePerHour: item.spotPricePerHour ?? null,
    outputPath: item.outputPath ?? null,
    outputPath720p: item.outputPath720p ?? null,
    outputBytes: item.outputBytes ?? null,
    outputBytes720p: item.outputBytes720p ?? null,
  };
}

/**
 * コスト集計を組み立てる。CloudFrontの配信料だけは**返すバケットの範囲に関わらず
 * 常に月次**で算出する（無料枠1TB/月がアカウント単位・月単位でしか判定できず、
 * 日次・週次のバケットへは原理的に配分できないため）。
 */
export async function summarizeCosts(
  table: string,
  params: CostSummaryParams,
): Promise<CostSummaryResult> {
  const jobs = (await scanAllJobs(table)).map(normalizeJob);

  const buckets = new Map<string, MutableBucket>();
  const deliveryBytesByMonth = new Map<string, number>();

  for (const job of jobs) {
    const time = bucketTimeOf(job);
    if (time === null) {
      continue;
    }
    const estimate = estimateJobCost(job, params.now);

    const key = costBucketKey(time, params.granularity);
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      bucket = newBucket(key);
      buckets.set(key, bucket);
    }
    bucket.jobCount += 1;
    if (job.status === "done") {
      bucket.doneCount += 1;
    } else if (job.status === "failed") {
      bucket.failedCount += 1;
    }
    if (job.workerKind === "home") {
      bucket.homeWorkerJobCount += 1;
    }
    bucket.breakdown = addCostBreakdown(bucket.breakdown, estimate.breakdown);
    bucket.totalUsd = sumCostBreakdown(bucket.breakdown);
    bucket.billedSeconds += estimate.billedSeconds;
    bucket.deliveryBytes += estimate.deliveryBytes;
    bucket.storedBytes += estimate.storedBytes;
    if (estimate.billedDurationSource === "assumed") {
      bucket.quality.assumedDurationJobs += 1;
    }
    if (estimate.spotPriceSource !== "recorded") {
      bucket.quality.fallbackSpotPriceJobs += 1;
    }
    if (estimate.outputSizeUnknown) {
      bucket.quality.unknownOutputSizeJobs += 1;
    }

    const month = costBucketKey(time, "monthly");
    deliveryBytesByMonth.set(month, (deliveryBytesByMonth.get(month) ?? 0) + estimate.deliveryBytes);
  }

  // 新しい順。キーは`YYYY-MM`/`YYYY-MM-DD`のゼロ埋め固定長なので辞書順＝時系列順。
  const sorted = [...buckets.values()].sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
  const page = sorted.slice(0, params.limit);

  const quality: AdminCostQuality = {
    assumedDurationJobs: 0,
    fallbackSpotPriceJobs: 0,
    unknownOutputSizeJobs: 0,
  };
  let jobCount = 0;
  for (const bucket of page) {
    quality.assumedDurationJobs += bucket.quality.assumedDurationJobs;
    quality.fallbackSpotPriceJobs += bucket.quality.fallbackSpotPriceJobs;
    quality.unknownOutputSizeJobs += bucket.quality.unknownOutputSizeJobs;
    jobCount += bucket.jobCount;
  }

  const cloudFront: AdminCloudFrontMonth[] = [...deliveryBytesByMonth.entries()]
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .slice(0, CLOUDFRONT_MONTHS_LIMIT)
    .map(([month, deliveryBytes]) => {
      const { deliveryGb, overageGb, usd } = estimateCloudFrontCost(deliveryBytes);
      return { month, deliveryBytes, deliveryGb, overageGb, usd };
    });

  return {
    // 内部用の`quality`を落として`AdminCostBucket`の形に揃える。
    buckets: page.map(({ quality: _bucketQuality, ...bucket }) => bucket),
    cloudFront,
    quality,
    jobCount,
    totalJobCount: jobs.length,
  };
}

/**
 * 当月（UTC基準）の推定コスト合計（USD）。月間コストガード（Issue #14）が閾値判定に
 * 使う値で、`GET /admin/costs`と同じ`summarizeCosts()`を再利用する——月次バケットの
 * 内訳合計に、月次でしか判定できないCloudFrontの無料枠超過分（`estimateCloudFrontCost`）
 * を足し合わせたものが「その月にかかった推定額」の全体になる。
 *
 * ジョブが1件も無い月はバケット自体が作られない（`summarizeCosts`はMapに存在する
 * キーしか返さない）ため、該当月が見つからなければ0として扱う。
 */
export async function estimateCurrentMonthCostUsd(table: string, now: Date): Promise<number> {
  const result = await summarizeCosts(table, { granularity: "monthly", limit: 1, now });
  const monthKey = costBucketKey(now, "monthly");
  const bucket = result.buckets.find((item) => item.key === monthKey);
  const cloudFront = result.cloudFront.find((item) => item.month === monthKey);
  return (bucket?.totalUsd ?? 0) + (cloudFront?.usd ?? 0);
}
