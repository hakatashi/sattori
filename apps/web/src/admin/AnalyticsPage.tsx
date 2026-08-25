import { useSearchParams } from "react-router-dom";
import { ADMIN_ANALYTICS_DEFAULT_DAYS } from "@sattori/shared";
import type { AdminAnalyticsBreakdownItem } from "@sattori/shared";
import { fetchAdminAnalytics } from "./adminApi.ts";
import { useAdminResource } from "./useAdminResource.ts";
import styles from "./AnalyticsPage.module.css";

const DAY_OPTIONS = [7, 30, 90];

function isDayOption(value: number): boolean {
  return DAY_OPTIONS.includes(value);
}

/**
 * 訪問者アナリティクス（`GET /admin/analytics`、Issue #149）。ユニーク訪問者数・
 * ページビュー数・パースエラー件数の日別推移と、属性別の内訳（ページ・参照元・
 * 国・言語・デバイス・ブラウザ/OS・UTM流入元・パースエラー種別）を表示する。
 *
 * ユニーク訪問者数は`visitorHash`（IPを日次saltでハッシュ化した仮ID）のユニーク件数で、
 * saltが日ごとにローテーションするため**日をまたいだ重複排除はできない**
 * （`docs/decisions/0026-hashed-visitor-id-daily-salt.md`）。複数日を選んだときの
 * 合計値はこの制約を画面上でも明示する（`totals.uniqueVisitorDays`のラベルと注記）。
 */
export function AnalyticsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const daysParam = Number(searchParams.get("days"));
  const days = isDayOption(daysParam) ? daysParam : ADMIN_ANALYTICS_DEFAULT_DAYS;

  const { data, loading, error } = useAdminResource(
    (token) => fetchAdminAnalytics(token, days),
    [days],
  );

  function handleDaysChange(next: string) {
    const params = new URLSearchParams(searchParams);
    params.set("days", next);
    setSearchParams(params);
  }

  const daily = data?.daily ?? [];
  // 表は新しい順（ジョブ一覧・コスト集計と同じ並び）。APIは古い順で返すため反転する。
  const dailyDescending = [...daily].reverse();
  const maxPageviews = Math.max(1, ...daily.map((bucket) => bucket.pageviews));
  const pageviewsPerVisitorDay =
    data && data.totals.uniqueVisitorDays > 0
      ? data.totals.pageviews / data.totals.uniqueVisitorDays
      : null;

  return (
    <section>
      <div className={styles.toolbar}>
        <label>
          期間:{" "}
          <select
            className={styles.select}
            value={days}
            onChange={(event) => handleDaysChange(event.target.value)}
          >
            {DAY_OPTIONS.map((value) => (
              <option key={value} value={value}>
                過去{value}日間
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
              <span className={styles.statLabel}>ページビュー</span>
              <span className={styles.statValue}>
                {data.totals.pageviews.toLocaleString("ja-JP")}
              </span>
              <span className={styles.statNote}>
                {data.from} 〜 {data.to}
              </span>
            </div>
            <div className={styles.stat}>
              <span className={styles.statLabel}>ユニーク訪問（日別合計）</span>
              <span className={styles.statValue}>
                {data.totals.uniqueVisitorDays.toLocaleString("ja-JP")}
              </span>
              <span className={styles.statNote}>日をまたぐ重複は排除できません</span>
            </div>
            <div className={styles.stat}>
              <span className={styles.statLabel}>パースエラー</span>
              <span className={styles.statValue}>
                {data.totals.parseErrors.toLocaleString("ja-JP")}
              </span>
            </div>
            <div className={styles.stat}>
              <span className={styles.statLabel}>訪問あたりPV</span>
              <span className={styles.statValue}>
                {pageviewsPerVisitorDay === null ? "-" : pageviewsPerVisitorDay.toFixed(2)}
              </span>
            </div>
          </div>

          <div className={styles.chartCard}>
            <h2 className={styles.cardHeading}>日別推移</h2>
            {dailyDescending.length === 0 ? (
              <p className={styles.empty}>該当する期間のイベントがありません</p>
            ) : (
              <table className={styles.chart}>
                <thead>
                  <tr>
                    <th>日付</th>
                    <th>ページビュー</th>
                    <th>ユニーク訪問者</th>
                    <th>パースエラー</th>
                  </tr>
                </thead>
                <tbody>
                  {dailyDescending.map((bucket) => (
                    <tr key={bucket.date}>
                      <th scope="row" className={styles.bucketKey}>
                        {bucket.date}
                      </th>
                      <td className={styles.barCell}>
                        <span className={styles.bar}>
                          <span
                            className={styles.barFill}
                            style={{ width: `${(bucket.pageviews / maxPageviews) * 100}%` }}
                          />
                        </span>
                        <span className={styles.barValue}>{bucket.pageviews}</span>
                      </td>
                      <td className={styles.numeric}>{bucket.uniqueVisitors}</td>
                      <td className={styles.numeric}>
                        {bucket.parseErrors > 0 ? (
                          <span className={styles.failed}>{bucket.parseErrors}</span>
                        ) : (
                          "-"
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className={styles.breakdownGrid}>
            <BreakdownCard title="ページ" items={data.breakdowns.paths} />
            <BreakdownCard title="参照元" items={data.breakdowns.referrers} />
            <BreakdownCard title="国" items={data.breakdowns.countries} />
            <BreakdownCard title="言語" items={data.breakdowns.languages} />
            <BreakdownCard title="デバイス" items={data.breakdowns.deviceCategories} />
            <BreakdownCard title="ブラウザ" items={data.breakdowns.browserFamilies} />
            <BreakdownCard title="OS" items={data.breakdowns.osFamilies} />
            <BreakdownCard title="流入元（UTM）" items={data.breakdowns.utmSources} />
            <BreakdownCard title="パースエラー種別" items={data.breakdowns.parseErrorCodes} />
            <BreakdownCard title="未対応タイトル検出" items={data.breakdowns.parseErrorGames} />
          </div>

          <p className={styles.disclaimer}>
            ユニーク訪問者数はIPを日次saltでハッシュ化した仮の訪問者ID（
            <code>visitorHash</code>）のユニーク件数です。saltは日ごとにローテーションする
            ため、複数日を選んだ場合の合計値は「日別ユニーク数の単純合計」であり、実際の
            期間内ユニーク訪問者数（同一人物の日をまたいだ重複を除いた数）より多く出ます。
          </p>
        </>
      )}
    </section>
  );
}

/**
 * 属性別の内訳カード。件数の多い順・最大10件（API側の`ADMIN_ANALYTICS_BREAKDOWN_LIMIT`）。
 * 棒は同一カード内の最大値を100%とする相対表示で、カード間の比較はできない
 * （そもそも母数（pageview由来かparse_error由来か等）が揃っていないため）。
 */
function BreakdownCard({ title, items }: { title: string; items: AdminAnalyticsBreakdownItem[] }) {
  const max = Math.max(1, ...items.map((item) => item.count));
  return (
    <div className={styles.breakdownCard}>
      <h3 className={styles.breakdownHeading}>{title}</h3>
      {items.length === 0 ? (
        <p className={styles.empty}>データがありません</p>
      ) : (
        <ul className={styles.breakdownList}>
          {items.map((item) => (
            <li key={item.key} className={styles.breakdownItem}>
              <span className={styles.breakdownKey} title={item.key}>
                {item.key}
              </span>
              <span className={styles.breakdownBarTrack}>
                <span
                  className={styles.breakdownBarFill}
                  style={{ width: `${(item.count / max) * 100}%` }}
                />
              </span>
              <span className={styles.breakdownCount}>{item.count.toLocaleString("ja-JP")}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
