import {
  COST_PRICING_AS_OF,
  COST_PRICING_REGION,
  estimateJobCost,
  OUTPUT_RETENTION_DAYS,
} from "@sattori/shared";
import type { JobRecord } from "@sattori/shared";
import { useCostCurrency } from "./adminCurrency.ts";
import {
  BILLED_DURATION_LABEL,
  COST_ITEM_LABELS,
  formatBytes,
  formatDuration,
  formatMoney,
  JPY_RATE_NOTE,
  SPOT_PRICE_LABEL,
} from "./costFormat.ts";
import styles from "./JobCostPanel.module.css";

interface Props {
  job: JobRecord;
}

/**
 * ジョブ1件のコスト推定（Issue #60）。計算は`@sattori/shared`の`estimateJobCost()`で、
 * 集計API(`GET /admin/costs`)と同じ実装を共有する（画面ごとに数字が食い違わないように）。
 *
 * `AdminJobDetailResponse`は`JobRecord`をそのまま返すので、この画面のためだけに
 * サーバー側でコストを計算して返す必要は無い（＝APIの契約を増やさずに済む）。
 *
 * **表示は推定値であって請求額ではない**。CloudFrontの配信料は無料枠(1TB/月)が
 * アカウント単位・月単位でしか判定できずジョブ単位に配分できないため、金額ではなく
 * 「このジョブが生む配信量」として出す。
 */
export function JobCostPanel({ job }: Props) {
  const { currency } = useCostCurrency();
  const estimate = estimateJobCost(job);
  // 自宅ワーカーが実行したジョブ（Issue #49）はEC2を1台も起動していないため、
  // 稼働時間に比例する項目（EC2 Spot/EBS/IPv4）はすべて0になる。このとき
  // `spotPricePerHour`は計算に使われていないフォールバック定数でしかなく、
  // 表示すると「この単価で課金された」と読めてしまうので出さない。
  const isHomeWorker = estimate.billedDurationSource === "home-worker";

  return (
    <div className={styles.panel}>
      <h2 className={styles.panelHeading}>コスト推定</h2>

      <p className={styles.total}>
        <span className={styles.totalValue}>{formatMoney(estimate.totalUsd, currency)}</span>
        <span className={styles.totalUnit}>/ このジョブ</span>
      </p>

      <table className={styles.breakdown}>
        <tbody>
          {COST_ITEM_LABELS.map(([key, label]) => (
            <tr key={key}>
              <th scope="row">{label}</th>
              <td className={styles.amount}>{formatMoney(estimate.breakdown[key], currency)}</td>
            </tr>
          ))}
          <tr className={styles.totalRow}>
            <th scope="row">合計</th>
            <td className={styles.amount}>{formatMoney(estimate.totalUsd, currency)}</td>
          </tr>
        </tbody>
      </table>

      <dl className={styles.fields}>
        <dt>課金対象時間</dt>
        <dd>
          {formatDuration(estimate.billedSeconds)}
          <span className={styles.note}>
            （{BILLED_DURATION_LABEL[estimate.billedDurationSource]}）
          </span>
        </dd>
        {!isHomeWorker && (
          <>
            <dt>Spot単価</dt>
            <dd>
              {formatMoney(estimate.spotPricePerHour, currency)}/時
              <span className={styles.note}>（{SPOT_PRICE_LABEL[estimate.spotPriceSource]}）</span>
            </dd>
          </>
        )}
        <dt>出力サイズ</dt>
        <dd>
          {estimate.outputSizeUnknown ? (
            <span className={styles.note}>未記録（このフィールド追加より前のジョブ）</span>
          ) : (
            <>
              {formatBytes(estimate.storedBytes)}
              <span className={styles.note}>（S3に{OUTPUT_RETENTION_DAYS}日保管）</span>
            </>
          )}
        </dd>
        <dt>CloudFront配信量</dt>
        <dd>
          {formatBytes(estimate.deliveryBytes)}
          <span className={styles.note}>
            （720p版1回ぶんの想定。無料枠1TB/月の消化状況はコスト集計ページ）
          </span>
        </dd>
      </dl>

      <p className={styles.disclaimer}>
        {COST_PRICING_REGION}の単価（{COST_PRICING_AS_OF}時点）に基づく推定値で、実際の請求額
        ではありません。
        {isHomeWorker ? (
          // 自宅ワーカーのジョブはEC2/EBS/IPv4が0で、代わりに電気代・回線費が
          // かかっているが、それはAWSの請求に現れず按分する意味も無いので
          // このモジュールでは一切計上しない（`@sattori/shared`の`cost.ts`）。
          <>
            {" "}
            このジョブは自宅ワーカーが実行したため、EC2 Spot・EBS・パブリックIPv4は発生せず0で計上しています（自宅サーバーの電気代・回線費はAWSの請求に現れないため一切含みません）。
          </>
        ) : (
          <> 試行間の待機時間もEC2稼働として数えるため、リトライしたジョブでは過大に出ます。</>
        )}
        {currency === "jpy" && <> {JPY_RATE_NOTE}</>}
      </p>
    </div>
  );
}
