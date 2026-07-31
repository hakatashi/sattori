import { Link, useParams } from "react-router-dom";
import { calculateDownloadExpiresAt, OUTPUT_RETENTION_DAYS } from "@sattori/shared";
import { fetchAdminJobDetail } from "./adminApi.ts";
import { useAdminResource } from "./useAdminResource.ts";
import { StatusBadge } from "./StatusBadge.tsx";
import { ExecutionPanel } from "./ExecutionPanel.tsx";
import { LogsPanel } from "./LogsPanel.tsx";
import styles from "./JobDetailPage.module.css";

function formatDateTime(iso: string | null): string {
  if (!iso) {
    return "-";
  }
  return new Date(iso).toLocaleString("ja-JP");
}

/**
 * ジョブ詳細(`GET /admin/jobs/{jobId}`)。`JobRecord`の全フィールドと
 * ダウンロード導線、Step Functionsの実行状態(`ExecutionPanel`)を表示する。
 */
export function JobDetailPage() {
  const { jobId } = useParams<{ jobId: string }>();
  const { data, loading, error } = useAdminResource(
    (token) => fetchAdminJobDetail(token, jobId ?? ""),
    [jobId],
  );

  if (!jobId) {
    return <p>jobIdが指定されていません</p>;
  }

  return (
    <section>
      <p>
        <Link to="/admin">← 一覧へ戻る</Link>
      </p>
      <h1 className={styles.heading}>{jobId}</h1>

      {loading && <p>読み込み中…</p>}
      {error && <p className={styles.error}>{error}</p>}

      {data && (
        <>
          <div className={styles.grid}>
            <div className={styles.panel}>
              <h2 className={styles.panelHeading}>ジョブ情報</h2>
              <dl className={styles.fields}>
                <dt>status</dt>
                <dd>
                  <StatusBadge status={data.job.status} />
                </dd>
                <dt>game</dt>
                <dd>{data.job.game}</dd>
                <dt>email</dt>
                <dd>{data.job.email ?? "-"}</dd>
                <dt>language</dt>
                <dd>{data.job.language}</dd>
                <dt>createdAt</dt>
                <dd>{formatDateTime(data.job.createdAt)}</dd>
                <dt>updatedAt</dt>
                <dd>{formatDateTime(data.job.updatedAt)}</dd>
                <dt>doneAt</dt>
                <dd>{formatDateTime(data.job.doneAt)}</dd>
                <dt>pendingExpiresAt</dt>
                <dd>{formatDateTime(data.job.pendingExpiresAt)}</dd>
                <dt>replayKey</dt>
                <dd>{data.job.replayKey}</dd>
                <dt>watermark</dt>
                <dd>{data.job.options.watermark ? "true" : "false"}</dd>
                <dt>progress</dt>
                <dd>{data.job.progress ?? "-"}</dd>
                <dt>estimatedDurationSeconds</dt>
                <dd>{data.job.estimatedDurationSeconds ?? "-"}</dd>
                {data.job.error && (
                  <>
                    <dt>error</dt>
                    <dd className={styles.error}>{data.job.error}</dd>
                  </>
                )}
              </dl>
            </div>

            <div className={styles.panel}>
              <h2 className={styles.panelHeading}>EC2インスタンス</h2>
              <dl className={styles.fields}>
                <dt>instanceId</dt>
                <dd>{data.job.instanceId ?? "-"}</dd>
                <dt>instanceType</dt>
                <dd>{data.job.instanceType ?? "-"}</dd>
                <dt>availabilityZone</dt>
                <dd>{data.job.availabilityZone ?? "-"}</dd>
              </dl>
            </div>

            {data.job.replayInfo && (
              <div className={styles.panel}>
                <h2 className={styles.panelHeading}>リプレイ情報</h2>
                <dl className={styles.fields}>
                  <dt>player</dt>
                  <dd>{data.job.replayInfo.player || "-"}</dd>
                  <dt>date</dt>
                  <dd>{data.job.replayInfo.date ?? "-"}</dd>
                  <dt>character</dt>
                  <dd>{data.job.replayInfo.character ?? "-"}</dd>
                  <dt>difficulty</dt>
                  <dd>{data.job.replayInfo.difficulty ?? "-"}</dd>
                  <dt>stage</dt>
                  <dd>{data.job.replayInfo.stage ?? "-"}</dd>
                  <dt>score</dt>
                  <dd>{data.job.replayInfo.score?.toLocaleString("ja-JP") ?? "-"}</dd>
                  <dt>cleared</dt>
                  <dd>{data.job.replayInfo.cleared === null ? "-" : String(data.job.replayInfo.cleared)}</dd>
                </dl>
              </div>
            )}

            <div className={styles.panel}>
              <h2 className={styles.panelHeading}>ダウンロード</h2>
              <ul className={styles.downloadList}>
                <li>
                  {data.downloads.replayUrl ? (
                    <a className={styles.downloadLink} href={data.downloads.replayUrl} download>
                      リプレイファイル(.rpy)
                    </a>
                  ) : (
                    <span className={styles.downloadDisabled}>リプレイファイル(.rpy) — 未取得/削除済み</span>
                  )}
                </li>
                <li>
                  {data.downloads.videoUrl ? (
                    <a className={styles.downloadLink} href={data.downloads.videoUrl} download>
                      動画（オリジナル解像度）
                    </a>
                  ) : (
                    <span className={styles.downloadDisabled}>動画（オリジナル解像度） — 未生成</span>
                  )}
                </li>
                <li>
                  {data.downloads.video720pUrl ? (
                    <a className={styles.downloadLink} href={data.downloads.video720pUrl} download>
                      動画（720p）
                    </a>
                  ) : (
                    <span className={styles.downloadDisabled}>動画（720p） — 未生成</span>
                  )}
                </li>
              </ul>
              {(() => {
                // 出力バケットは`OUTPUT_RETENTION_DAYS`日でオブジェクトを自動削除する。
                // 起点はアップロード時刻ではなく`doneAt`(status "done"遷移時刻。ほぼ同時刻に
                // 確定する)。ユーザー向けページ・完了メールと同じ計算(`calculateDownloadExpiresAt`)
                // を使うことで表示がずれないようにする(main合流時にIssue #56で追加)。
                const expiresAt = calculateDownloadExpiresAt(data.job.doneAt);
                if (!expiresAt) {
                  return null;
                }
                const expired = new Date(expiresAt).getTime() < Date.now();
                return (
                  <p className={styles.staleNotice}>
                    {expired
                      ? `出力バケットの保持期間(${OUTPUT_RETENTION_DAYS}日)を過ぎているため、動画は削除済みの可能性があります。`
                      : `ダウンロード期限: ${formatDateTime(expiresAt)}（出力バケットの保持期間${OUTPUT_RETENTION_DAYS}日）`}
                  </p>
                );
              })()}
              {data.downloads.previewImageUrl && (
                <img
                  className={styles.previewImage}
                  src={data.downloads.previewImageUrl}
                  alt="録画中のプレビュー画像"
                />
              )}
            </div>
          </div>

          <ExecutionPanel jobId={jobId} />
          <LogsPanel jobId={jobId} instanceId={data.job.instanceId} />
        </>
      )}
    </section>
  );
}
