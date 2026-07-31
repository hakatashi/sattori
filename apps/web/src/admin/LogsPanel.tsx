import { useEffect, useState } from "react";
import type { AdminLogEvent } from "@sattori/shared";
import { AdminUnauthorizedError, fetchAdminLogs } from "./adminApi.ts";
import { useAdminAuth } from "./AdminAuthContext.ts";
import styles from "./LogsPanel.module.css";

interface Props {
  jobId: string;
  instanceId: string | null;
}

function formatTimestamp(ts: number | null): string {
  if (ts === null) {
    return "-";
  }
  return new Date(ts).toLocaleString("ja-JP");
}

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "不明なエラーが発生しました";
}

/**
 * ワーカーコンテナのCloudWatch Logs(`GET /admin/jobs/{jobId}/logs`、Issue #58)。
 * ロググループは固定(`/sattori/worker`)、ログストリーム名はjobIdなのでAPI側で解決する。
 * 「さらに古いログを読み込む」は前ページの`nextBackwardToken`を`cursor`に渡して先頭へ
 * 積み増す(`useAdminResource`は依存配列変更での再取得しか扱えないため、ここだけ自前で状態管理する)。
 */
export function LogsPanel({ jobId, instanceId }: Props) {
  const { token, onUnauthorized } = useAdminAuth();
  const [events, setEvents] = useState<AdminLogEvent[]>([]);
  const [logStreamFound, setLogStreamFound] = useState(true);
  const [consoleOutput, setConsoleOutput] = useState<string | null>(null);
  const [nextBackwardToken, setNextBackwardToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetchAdminLogs(token, jobId, { instanceId })
      .then((res) => {
        if (cancelled) {
          return;
        }
        setLogStreamFound(res.logStreamFound);
        setEvents(res.events);
        setNextBackwardToken(res.nextBackwardToken);
        setConsoleOutput(res.consoleOutput);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) {
          return;
        }
        if (err instanceof AdminUnauthorizedError) {
          onUnauthorized();
          return;
        }
        setError(toErrorMessage(err));
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // onUnauthorizedはdepsに含めない(useAdminResource.tsと同じ方針)。
  }, [jobId, instanceId, token]);

  const loadOlder = () => {
    if (!nextBackwardToken || loadingMore) {
      return;
    }
    setLoadingMore(true);
    fetchAdminLogs(token, jobId, { cursor: nextBackwardToken, instanceId })
      .then((res) => {
        setEvents((prev) => [...res.events, ...prev]);
        setNextBackwardToken(res.nextBackwardToken);
        setLoadingMore(false);
      })
      .catch((err) => {
        if (err instanceof AdminUnauthorizedError) {
          onUnauthorized();
          return;
        }
        setError(toErrorMessage(err));
        setLoadingMore(false);
      });
  };

  return (
    <section className={styles.section}>
      <h2 className={styles.heading}>ワーカーログ</h2>
      {loading && <p>読み込み中…</p>}
      {error && <p className={styles.error}>{error}</p>}

      {!loading && logStreamFound && (
        <>
          <p className={styles.note}>
            Step Functionsのリトライが発生した場合、複数回の試行のログが同一ストリームに混在します。
          </p>
          {nextBackwardToken && (
            <button
              type="button"
              className={styles.loadMore}
              onClick={loadOlder}
              disabled={loadingMore}
            >
              {loadingMore ? "読み込み中…" : "さらに古いログを読み込む"}
            </button>
          )}
          <pre className={styles.log}>
            {events.length === 0
              ? "(ログがありません)"
              : events
                  .map((e) => `[${formatTimestamp(e.timestamp)}] ${e.message}`)
                  .join("\n")}
          </pre>
        </>
      )}

      {!loading && !logStreamFound && (
        <>
          <p className={styles.note}>
            ログストリームが見つかりません。コンテナが一度も起動できず、UserData(bootstrap)段階
            (ECRログイン・pull等)で失敗した可能性があります。
          </p>
          {consoleOutput ? (
            <>
              <p className={styles.note}>代わりにEC2インスタンスのコンソール出力を表示します。</p>
              <pre className={styles.log}>{consoleOutput}</pre>
            </>
          ) : (
            <p>
              コンソール出力も取得できませんでした（インスタンスが既に終了している場合は取得できません）。
            </p>
          )}
        </>
      )}
    </section>
  );
}
