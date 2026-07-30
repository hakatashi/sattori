import { fetchAdminExecution } from "./adminApi.ts";
import { useAdminResource } from "./useAdminResource.ts";
import styles from "./ExecutionPanel.module.css";

interface Props {
  jobId: string;
}

/**
 * ジョブに対応するStep Functions実行の状態・履歴(`GET /admin/jobs/{jobId}/execution`)。
 * `JobDetailPage`とは別にfetchする（SFNが不調でもジョブ詳細本体はDynamoDB由来の
 * 情報だけで描画できるようにするため。Issue #51）。
 */
export function ExecutionPanel({ jobId }: Props) {
  const { data, loading, error } = useAdminResource(
    (token) => fetchAdminExecution(token, jobId),
    [jobId],
  );

  return (
    <section className={styles.section}>
      <h2 className={styles.heading}>Step Functions 実行</h2>
      {loading && <p>読み込み中…</p>}
      {error && <p>{error}</p>}
      {data && !data.execution && (
        <p>
          実行が見つかりません（起動前のジョブ、または実行履歴の保持期間(90日)を過ぎている可能性があります）。
        </p>
      )}
      {data?.execution && (
        <>
          <dl className={styles.summary}>
            <dt>executionArn</dt>
            <dd>{data.execution.executionArn}</dd>
            <dt>status</dt>
            <dd>{data.execution.status}</dd>
            <dt>startDate</dt>
            <dd>{data.execution.startDate ?? "-"}</dd>
            <dt>stopDate</dt>
            <dd>{data.execution.stopDate ?? "-"}</dd>
            {data.execution.error && (
              <>
                <dt>error</dt>
                <dd>{data.execution.error}</dd>
              </>
            )}
            {data.execution.cause && (
              <>
                <dt>cause</dt>
                <dd>{data.execution.cause}</dd>
              </>
            )}
          </dl>

          <ul className={styles.eventList}>
            {data.events.map((event) => (
              <li key={event.id} className={styles.event}>
                <div className={styles.eventHead}>
                  <span>#{event.id}</span>
                  <span>{event.type}</span>
                  <span>{event.timestamp ?? "-"}</span>
                </div>
                {event.details && (
                  <pre className={styles.eventDetails}>{JSON.stringify(event.details, null, 2)}</pre>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
