import { CloudWatchClient, GetMetricDataCommand } from "@aws-sdk/client-cloudwatch";

/**
 * CloudFrontの実配信量を CloudWatch `AWS/CloudFront` 名前空間の `BytesDownloaded`
 * メトリクスから取得する（Issue #163）。管理画面のコスト集計（`adminCosts.ts`）が、
 * ジョブ単位の推定値（`estimateJobCost().deliveryBytes`）と併記するために使う。
 *
 * **メトリクスは常に `us-east-1` にしか存在しない**（CloudFrontはグローバルサービス
 * のため）。Lambda実行リージョン（eu-south-2）とは別にクライアントを生成する必要が
 * あり、`apps/api/src/ses.ts` の `sesClient()` と同じ理由・同じ遅延生成パターンを使う。
 */
let _cloudwatch: CloudWatchClient | null = null;
function cloudwatchClient(): CloudWatchClient {
  if (!_cloudwatch) {
    _cloudwatch = new CloudWatchClient({ region: "us-east-1" });
  }
  return _cloudwatch;
}

/** CloudWatchのタイムスタンプ(Date)をUTC基準の`YYYY-MM`へ丸める。 */
function monthKeyOf(date: Date): string {
  return date.toISOString().slice(0, 7);
}

/**
 * `since`（月初、UTC）から`now`までの `BytesDownloaded` を日次Sumで取得し、
 * 月ごとに合算して返す。月単位のPeriodはCloudWatchが受け付けない（60の倍数秒
 * である必要があり、暦月は日数が一定しない）ため、1日粒度で取ってからアプリ側で
 * 月に合算する——`adminCosts.ts`がDynamoDBの全件Scan結果を月ごとに合算しているのと
 * 同じ考え方（`summarizeCosts()`の`deliveryBytesByMonth`）。
 *
 * `distributionId`が空文字列、権限不足、メトリクスがまだ存在しない等で呼び出しが
 * 失敗した場合は空のMapを返す。呼び出し元はこれを「実測値なし」として扱い、
 * 既存の推定値表示自体は壊さない（`docs/decisions/0021`と同じ「付随データは
 * 本体を壊さない」方針）。
 */
export async function fetchMeasuredCloudFrontBytesByMonth(
  distributionId: string,
  since: Date,
  now: Date,
): Promise<Map<string, number>> {
  const byMonth = new Map<string, number>();
  try {
    const result = await cloudwatchClient().send(
      new GetMetricDataCommand({
        StartTime: since,
        EndTime: now,
        MetricDataQueries: [
          {
            Id: "bytesDownloaded",
            MetricStat: {
              Metric: {
                Namespace: "AWS/CloudFront",
                MetricName: "BytesDownloaded",
                Dimensions: [
                  { Name: "DistributionId", Value: distributionId },
                  { Name: "Region", Value: "Global" },
                ],
              },
              Period: 86400,
              Stat: "Sum",
            },
            ReturnData: true,
          },
        ],
      }),
    );

    const timestamps = result.MetricDataResults?.[0]?.Timestamps ?? [];
    const values = result.MetricDataResults?.[0]?.Values ?? [];
    timestamps.forEach((timestamp, index) => {
      const month = monthKeyOf(timestamp);
      byMonth.set(month, (byMonth.get(month) ?? 0) + (values[index] ?? 0));
    });
  } catch (err) {
    console.error("GetMetricData(AWS/CloudFront BytesDownloaded) failed", {
      distributionId,
      error: err,
    });
  }
  return byMonth;
}
