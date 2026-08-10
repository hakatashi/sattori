import { Link, useParams } from "react-router-dom";
import { calculateDownloadExpiresAt, OUTPUT_RETENTION_DAYS } from "@sattori/shared";
import type { WorkerKind } from "@sattori/shared";
import { toLocalizedPath } from "../i18n/paths.ts";
import { fetchAdminJobDetail } from "./adminApi.ts";
import { useAdminResource } from "./useAdminResource.ts";
import { StatusBadge } from "./StatusBadge.tsx";
import { JobActionsPanel } from "./JobActionsPanel.tsx";
import { JobCostPanel } from "./JobCostPanel.tsx";
import { ExecutionPanel } from "./ExecutionPanel.tsx";
import { LogsPanel } from "./LogsPanel.tsx";
import styles from "./JobDetailPage.module.css";

function formatDateTime(iso: string | null): string {
  if (!iso) {
    return "-";
  }
  return new Date(iso).toLocaleString("ja-JP");
}

/** `workerKind`の表示名。未割り当て(null)も含めて1つのRecordで引けるようにする。 */
const WORKER_KIND_LABEL: Record<WorkerKind | "unassigned", string> = {
  ec2: "ec2（EC2 Fleet / Spot）",
  home: "home（自宅サーバーの常駐デーモン）",
  unassigned: "-（未割り当て）",
};

/**
 * ジョブ詳細(`GET /admin/jobs/{jobId}`)。`JobRecord`の全フィールドと
 * ダウンロード導線、Step Functionsの実行状態(`ExecutionPanel`)を表示する。
 */
export function JobDetailPage() {
  const { jobId } = useParams<{ jobId: string }>();
  const { data, loading, error, reload } = useAdminResource(
    (token) => fetchAdminJobDetail(token, jobId ?? ""),
    [jobId],
  );

  if (!jobId) {
    return <p>jobIdが指定されていません</p>;
  }

  const isHomeWorker = data?.job.workerKind === "home";

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
          {/* ユーザー向けジョブページ(ページB)。jobId自体が認可の秘密値なので
              (AGENTS.md §3)、管理者もこのURLを開けばユーザーと同じ画面をそのまま
              確認できる。言語はジョブに記録された表示言語(マジックリンクメールの
              リンクと同じ)に合わせる。同一SPA内だが`<Link>`にすると管理画面から
              離脱してしまうため、別タブで開く。 */}
          <p className={styles.userPageLink}>
            <a
              href={toLocalizedPath(`/jobs/${encodeURIComponent(jobId)}`, data.job.language)}
              target="_blank"
              rel="noreferrer"
            >
              ユーザー向けジョブページを開く ↗
            </a>
          </p>

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
                <dt>launchedAt</dt>
                <dd>{formatDateTime(data.job.launchedAt)}</dd>
                <dt>doneAt</dt>
                <dd>{formatDateTime(data.job.doneAt)}</dd>
                <dt>pendingExpiresAt</dt>
                <dd>{formatDateTime(data.job.pendingExpiresAt)}</dd>
                <dt>replayKey</dt>
                <dd>{data.job.replayKey}</dd>
                <dt>retriedToJobId</dt>
                <dd>
                  {data.job.retriedToJobId ? (
                    <Link to={`/admin/jobs/${encodeURIComponent(data.job.retriedToJobId)}`}>
                      {data.job.retriedToJobId}
                    </Link>
                  ) : (
                    "-"
                  )}
                </dd>
                <dt>retriedFromJobId</dt>
                <dd>
                  {data.job.retriedFromJobId ? (
                    <Link to={`/admin/jobs/${encodeURIComponent(data.job.retriedFromJobId)}`}>
                      {data.job.retriedFromJobId}
                    </Link>
                  ) : (
                    "-"
                  )}
                </dd>
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
              <h2 className={styles.panelHeading}>操作</h2>
              <JobActionsPanel job={data.job} onJobChanged={reload} />
            </div>

            {/* ワーカーはEC2 Fleetと自宅サーバーの2種類あり(Issue #49)、意味のある
                フィールドがまったく違う。自宅ワーカーのジョブにEC2の欄（instanceType・
                Spot単価など）を並べても常に「-」で、EC2で走ったかのような誤解を招くため、
                `workerKind`で表示を切り替える。 */}
            <div className={styles.panel}>
              <h2 className={styles.panelHeading}>
                {isHomeWorker ? "ワーカー（自宅サーバー）" : "ワーカー（EC2インスタンス）"}
              </h2>
              <dl className={styles.fields}>
                <dt>workerKind</dt>
                <dd>{WORKER_KIND_LABEL[data.job.workerKind ?? "unassigned"]}</dd>
                {isHomeWorker ? (
                  <>
                    <dt>assignedWorkerId</dt>
                    <dd>{data.job.assignedWorkerId ?? "-"}</dd>
                    <dt>homeWorkerHeartbeatAt</dt>
                    <dd>{formatDateTime(data.job.homeWorkerHeartbeatAt ?? null)}</dd>
                  </>
                ) : (
                  <>
                    <dt>instanceId</dt>
                    <dd>{data.job.instanceId ?? "-"}</dd>
                    <dt>instanceType</dt>
                    <dd>{data.job.instanceType ?? "-"}</dd>
                    <dt>availabilityZone</dt>
                    <dd>{data.job.availabilityZone ?? "-"}</dd>
                    <dt>spotPricePerHour</dt>
                    <dd>
                      {data.job.spotPricePerHour === null ? "-" : `$${data.job.spotPricePerHour}`}
                    </dd>
                  </>
                )}
                {/* 自宅ワーカーへオファー中のジョブだけが持つ属性(sparse GSIのキー)。
                    割り当てが決まる前の待ち状態を管理画面から追えるようにする。 */}
                {data.job.homeWorkerOfferState && (
                  <>
                    <dt>homeWorkerOfferState</dt>
                    <dd>{data.job.homeWorkerOfferState}</dd>
                    <dt>homeWorkerOfferExpiresAt</dt>
                    <dd>{formatDateTime(data.job.homeWorkerOfferExpiresAt ?? null)}</dd>
                  </>
                )}
              </dl>
            </div>

            <JobCostPanel job={data.job} />

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
          <LogsPanel
            jobId={jobId}
            status={data.job.status}
            workerKind={data.job.workerKind}
            instanceId={data.job.instanceId}
            ffmpegLogUrl={data.downloads.ffmpegLogUrl}
          />
        </>
      )}
    </section>
  );
}
