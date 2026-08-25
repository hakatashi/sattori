import { useSearchParams } from "react-router-dom";
import {
  CLOUDFRONT_FREE_TIER_GB_PER_MONTH,
  COST_GRANULARITIES,
  COST_PRICING_AS_OF,
  COST_PRICING_REGION,
} from "@sattori/shared";
import type { AdminCostBucket, CostGranularity } from "@sattori/shared";
import { fetchAdminCosts } from "./adminApi.ts";
import { useCostCurrency } from "./adminCurrency.ts";
import type { CostCurrency } from "./adminCurrency.ts";
import { useAdminResource } from "./useAdminResource.ts";
import {
  COST_ITEM_LABELS,
  formatBytes,
  formatDuration,
  formatMoney,
  JPY_RATE_NOTE,
} from "./costFormat.ts";
import styles from "./CostsPage.module.css";

const GRANULARITY_LABELS: Record<CostGranularity, string> = {
  daily: "日次",
  weekly: "週次",
  monthly: "月次",
};

function isGranularity(value: string): value is CostGranularity {
  return (COST_GRANULARITIES as readonly string[]).includes(value);
}

/** バケットキーの表示。週次は「その週の月曜日」なので週であることを明示する。 */
function formatBucketKey(key: string, granularity: CostGranularity): string {
  return granularity === "weekly" ? `${key} 週` : key;
}

/**
 * コスト集計（`GET /admin/costs`、Issue #60）。日次/週次/月次でジョブのコスト推定を
 * 積み上げて表示する。
 *
 * 積み上げ棒は内訳の**比率**を素早く掴むためのもので、正確な値は凡例（期間合計）と
 * 各行の合計金額のテキストで読ませる。棒の色だけに情報を持たせないための構成
 * （色覚特性・印刷への配慮）。
 */
export function CostsPage() {
  const { currency } = useCostCurrency();
  const [searchParams, setSearchParams] = useSearchParams();
  const granularityParam = searchParams.get("granularity");
  const granularity =
    granularityParam && isGranularity(granularityParam) ? granularityParam : "monthly";

  const { data, loading, error } = useAdminResource(
    (token) => fetchAdminCosts(token, { granularity }),
    [granularity],
  );

  function handleGranularityChange(next: string) {
    const params = new URLSearchParams(searchParams);
    params.set("granularity", next);
    setSearchParams(params);
  }

  const buckets = data?.buckets ?? [];
  const periodTotal = buckets.reduce((sum, bucket) => sum + bucket.totalUsd, 0);
  const periodBilledSeconds = buckets.reduce((sum, bucket) => sum + bucket.billedSeconds, 0);
  // 棒の長さの基準。全バケット中の最大額を100%とする（0除算を避けるため下限1）。
  const maxTotal = Math.max(1e-9, ...buckets.map((bucket) => bucket.totalUsd));

  return (
    <section>
      <div className={styles.toolbar}>
        <label>
          粒度:{" "}
          <select
            className={styles.select}
            value={granularity}
            onChange={(event) => handleGranularityChange(event.target.value)}
          >
            {COST_GRANULARITIES.map((value) => (
              <option key={value} value={value}>
                {GRANULARITY_LABELS[value]}
              </option>
            ))}
          </select>
        </label>
        {loading && <span className={styles.muted}>読み込み中…</span>}
      </div>

      {error && <p className={styles.error}>{error}</p>}

      {data && (
        <>
          <div className={styles.stats}>
            <div className={styles.stat}>
              <span className={styles.statLabel}>表示期間の合計</span>
              <span className={styles.statValue}>{formatMoney(periodTotal, currency, 2)}</span>
            </div>
            <div className={styles.stat}>
              <span className={styles.statLabel}>ジョブ数</span>
              <span className={styles.statValue}>{data.jobCount.toLocaleString("ja-JP")}</span>
              <span className={styles.statNote}>
                全期間 {data.totalJobCount.toLocaleString("ja-JP")} 件
              </span>
            </div>
            <div className={styles.stat}>
              <span className={styles.statLabel}>1ジョブ平均</span>
              <span className={styles.statValue}>
                {data.jobCount > 0 ? formatMoney(periodTotal / data.jobCount, currency) : "-"}
              </span>
            </div>
            <div className={styles.stat}>
              <span className={styles.statLabel}>EC2稼働時間</span>
              <span className={styles.statValue}>{formatDuration(periodBilledSeconds)}</span>
            </div>
          </div>

          <div className={styles.chartCard}>
            <h2 className={styles.cardHeading}>内訳の推移（{GRANULARITY_LABELS[granularity]}）</h2>

            <ul className={styles.legend}>
              {COST_ITEM_LABELS.map(([key, label], index) => {
                const seriesTotal = buckets.reduce(
                  (sum, bucket) => sum + bucket.breakdown[key],
                  0,
                );
                return (
                  <li key={key} className={styles.legendItem}>
                    <span className={styles[`swatch${index + 1}`]} aria-hidden="true" />
                    <span>{label}</span>
                    <span className={styles.legendValue}>
                      {formatMoney(seriesTotal, currency, 2)}
                    </span>
                  </li>
                );
              })}
            </ul>

            {buckets.length === 0 ? (
              <p className={styles.empty}>該当するジョブがありません</p>
            ) : (
              <table className={styles.chart}>
                <tbody>
                  {buckets.map((bucket) => (
                    <tr key={bucket.key}>
                      <th scope="row" className={styles.bucketKey}>
                        {formatBucketKey(bucket.key, granularity)}
                      </th>
                      <td className={styles.barCell}>
                        <Bar bucket={bucket} maxTotal={maxTotal} currency={currency} />
                      </td>
                      <td className={styles.barTotal}>
                        {formatMoney(bucket.totalUsd, currency, 2)}
                      </td>
                      <td className={styles.barMeta}>
                        {bucket.jobCount}件
                        {bucket.failedCount > 0 && (
                          <span className={styles.failed}>（失敗{bucket.failedCount}）</span>
                        )}
                        {/* 自宅ワーカー（Issue #49）が処理したジョブはEC2課金が
                            発生しない。額が低い理由が「録画が少ない」のか
                            「自宅が吸収した」のかを読み取れるようにする。 */}
                        {bucket.homeWorkerJobCount > 0 && (
                          <span>（自宅{bucket.homeWorkerJobCount}）</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className={styles.chartCard}>
            <h2 className={styles.cardHeading}>CloudFront 配信量（月次・無料枠1TB/月）</h2>
            <p className={styles.cardNote}>
              無料枠はアカウント単位・月単位でしか判定できないため、粒度の指定によらず常に
              月次で表示する。「配信量」は「720p版が1回ダウンロードされる」前提の見積りで、
              元解像度版も落とされていれば実際の配信量はこれより増える。「実測」は
              CloudWatch（`AWS/CloudFront`の`BytesDownloaded`）から取得した実際の配信量
              （Issue #163）で、再ダウンロード・レンジリクエストも含む。無料枠判定・
              超過額はいずれも見積りの「配信量」側で計算しており、実測値は突き合わせ用の
              参考値。
            </p>
            {data.cloudFront.length === 0 ? (
              <p className={styles.empty}>配信量の記録がありません</p>
            ) : (
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>月</th>
                    <th>配信量（見積り）</th>
                    <th>配信量（実測）</th>
                    <th>無料枠の消化</th>
                    <th>超過</th>
                    <th>推定額</th>
                  </tr>
                </thead>
                <tbody>
                  {data.cloudFront.map((month) => {
                    const ratio = Math.min(
                      1,
                      month.deliveryGb / CLOUDFRONT_FREE_TIER_GB_PER_MONTH,
                    );
                    return (
                      <tr key={month.month}>
                        <td>{month.month}</td>
                        <td className={styles.numeric}>{formatBytes(month.deliveryBytes)}</td>
                        <td className={styles.numeric}>
                          {/* `== null`はnullに加え、デプロイの前後でAPIが
                              このフィールドをまだ返さない場合のundefinedも
                              まとめて弾く（`formatBytes`側もNaN対策済みだが、
                              ここでは型を`number`へ narrow するために必要）。 */}
                          {month.measuredDeliveryBytes == null
                            ? "-"
                            : formatBytes(month.measuredDeliveryBytes)}
                        </td>
                        <td>
                          <span className={styles.gauge}>
                            <span
                              className={month.overageGb > 0 ? styles.gaugeOver : styles.gaugeFill}
                              style={{ width: `${ratio * 100}%` }}
                            />
                          </span>
                          <span className={styles.gaugeLabel}>{(ratio * 100).toFixed(0)}%</span>
                        </td>
                        <td className={styles.numeric}>
                          {month.overageGb > 0 ? `${month.overageGb.toFixed(1)} GB` : "-"}
                        </td>
                        <td className={styles.numeric}>{formatMoney(month.usd, currency, 2)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          <QualityNotice quality={data.quality} jobCount={data.jobCount} />

          <p className={styles.disclaimer}>
            {COST_PRICING_REGION}の単価（{COST_PRICING_AS_OF}時点、
            <code>docs/aws-region-cost-analysis.md</code>）に基づく推定値で、実際のAWS請求額
            ではありません。EC2稼働時間はリトライ間の待機も含む実時間で数えるため、失敗を
            繰り返したジョブでは過大に出ます。
            {currency === "jpy" && <> {JPY_RATE_NOTE}</>}
          </p>
        </>
      )}
    </section>
  );
}

/**
 * 1バケットぶんの積み上げ棒。セグメント間に2pxの隙間を空け、色が隣接して溶け合わない
 * ようにする（色覚特性への配慮。塗り分けだけに頼らない）。
 */
function Bar({
  bucket,
  maxTotal,
  currency,
}: {
  bucket: AdminCostBucket;
  maxTotal: number;
  currency: CostCurrency;
}) {
  const widthRatio = bucket.totalUsd / maxTotal;
  return (
    <span className={styles.bar} style={{ width: `${widthRatio * 100}%` }}>
      {COST_ITEM_LABELS.map(([key, label], index) => {
        const value = bucket.breakdown[key];
        if (value <= 0) {
          return null;
        }
        const share = bucket.totalUsd > 0 ? value / bucket.totalUsd : 0;
        return (
          <span
            key={key}
            className={styles[`segment${index + 1}`]}
            style={{ width: `${share * 100}%` }}
            title={`${label}: ${formatMoney(value, currency, 4)}`}
          />
        );
      })}
    </span>
  );
}

/**
 * 推定の確からしさの注記。コスト算出用フィールドはIssue #60で追加したもので、
 * それ以前のジョブは値を持たない＝表示中の数字にどれだけ仮定が混ざっているかを
 * 明示しないと、運用者が推定値を実績として読んでしまう。
 */
function QualityNotice({
  quality,
  jobCount,
}: {
  quality: { assumedDurationJobs: number; fallbackSpotPriceJobs: number; unknownOutputSizeJobs: number };
  jobCount: number;
}) {
  const notices: string[] = [];
  if (quality.assumedDurationJobs > 0) {
    notices.push(
      `${quality.assumedDurationJobs}/${jobCount}件は起動時刻(launchedAt)が未記録で、稼働時間を実績平均で代用しています`,
    );
  }
  if (quality.fallbackSpotPriceJobs > 0) {
    notices.push(
      `${quality.fallbackSpotPriceJobs}/${jobCount}件はSpot単価が未記録で、インスタンスタイプ帯の平均値を使っています`,
    );
  }
  if (quality.unknownOutputSizeJobs > 0) {
    notices.push(
      `${quality.unknownOutputSizeJobs}/${jobCount}件は出力動画のサイズが未記録で、S3保管料と配信量が過小に出ます`,
    );
  }
  if (notices.length === 0) {
    return null;
  }
  return (
    <div className={styles.quality}>
      <p className={styles.qualityHeading}>推定の確からしさ</p>
      <ul className={styles.qualityList}>
        {notices.map((notice) => (
          <li key={notice}>{notice}</li>
        ))}
      </ul>
    </div>
  );
}
