import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { JOB_STATUSES, type JobStatus } from "@sattori/shared";
import { fetchAdminJobs } from "./adminApi.ts";
import { useAdminResource } from "./useAdminResource.ts";
import { StatusBadge } from "./StatusBadge.tsx";
import styles from "./JobListPage.module.css";

function isJobStatus(value: string): value is JobStatus {
  return (JOB_STATUSES as readonly string[]).includes(value);
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("ja-JP");
}

/**
 * ジョブ一覧(`GET /admin/jobs`)。新しい順・statusフィルタ・カーソルページングに対応する。
 * status/cursorはURLの検索パラメータに載せる（リロード・ブラウザバックが自然に動く
 * ようにするため）。「前へ」は訪問済みカーソルのスタックをコンポーネントstateで持つ
 * （APIのカーソルは片方向=次ページ取得専用のため、戻る操作はクライアント側で管理する）。
 */
export function JobListPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const statusParam = searchParams.get("status");
  const status = statusParam && isJobStatus(statusParam) ? statusParam : undefined;
  const cursor = searchParams.get("cursor") ?? undefined;
  const [cursorHistory, setCursorHistory] = useState<(string | undefined)[]>([]);

  const { data, loading, error } = useAdminResource(
    (token) => fetchAdminJobs(token, { status, cursor }),
    [status, cursor],
  );

  function handleStatusChange(next: string) {
    setCursorHistory([]);
    const params = new URLSearchParams();
    if (next) {
      params.set("status", next);
    }
    setSearchParams(params);
  }

  function handleNext() {
    if (!data?.nextCursor) {
      return;
    }
    setCursorHistory((prev) => [...prev, cursor]);
    const params = new URLSearchParams(searchParams);
    params.set("cursor", data.nextCursor);
    setSearchParams(params);
  }

  function handlePrev() {
    const previousCursor = cursorHistory[cursorHistory.length - 1];
    setCursorHistory((prev) => prev.slice(0, -1));
    const params = new URLSearchParams(searchParams);
    if (previousCursor) {
      params.set("cursor", previousCursor);
    } else {
      params.delete("cursor");
    }
    setSearchParams(params);
  }

  return (
    <section>
      <div className={styles.toolbar}>
        <label>
          status:{" "}
          <select
            className={styles.select}
            value={status ?? ""}
            onChange={(event) => handleStatusChange(event.target.value)}
          >
            <option value="">すべて</option>
            {JOB_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
      </div>

      {loading && <p>読み込み中…</p>}
      {error && <p className={styles.errorCell}>{error}</p>}

      {data && (
        <>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>jobId</th>
                  <th>game</th>
                  <th>status</th>
                  <th>worker</th>
                  <th>createdAt</th>
                  <th>email</th>
                  <th>error</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((job) => (
                  <tr key={job.jobId}>
                    <td className={styles.jobIdCell}>
                      <Link to={`/admin/jobs/${encodeURIComponent(job.jobId)}`}>{job.jobId}</Link>
                    </td>
                    <td>{job.game}</td>
                    <td>
                      <StatusBadge status={job.status} />
                    </td>
                    {/* 自宅ワーカー(Issue #49)が処理したジョブはEC2課金が発生しない。
                        一覧で見分けられるようにしておく（未割り当ては "-"）。 */}
                    <td>{job.workerKind ?? "-"}</td>
                    <td>{formatDateTime(job.createdAt)}</td>
                    <td>{job.email ?? "-"}</td>
                    <td className={styles.errorCell} title={job.error ?? undefined}>
                      {job.error ?? "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.items.length === 0 && <p className={styles.empty}>ジョブがありません</p>}

          <div className={styles.pager}>
            <button
              className={styles.pagerButton}
              type="button"
              disabled={cursorHistory.length === 0}
              onClick={handlePrev}
            >
              前へ
            </button>
            <button
              className={styles.pagerButton}
              type="button"
              disabled={!data.nextCursor}
              onClick={handleNext}
            >
              次へ
            </button>
          </div>
        </>
      )}
    </section>
  );
}
