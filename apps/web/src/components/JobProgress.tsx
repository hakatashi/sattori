import { useState } from "react";
import type { GetJobResponse, JobStatus } from "@sattori/shared";
import { useJobPolling } from "../hooks/useJobPolling.ts";
import { downloadFile } from "../lib/downloadFile.ts";
import { buildDownloadFilename } from "../lib/downloadFilename.ts";
import { ReplayPreview } from "./ReplayPreview.tsx";
import styles from "./JobProgress.module.css";

interface Props {
  jobId: string;
}

interface ViewProps {
  job: GetJobResponse | null;
  loadError: string | null;
}

/** 各ステータスのユーザー向け表示文言と進捗段階（0..4）。 */
const STATUS_META: Record<JobStatus, { label: string; step: number }> = {
  pending: { label: "録画の準備をしています", step: 0 },
  queued: { label: "録画の順番を待っています", step: 0 },
  launching: { label: "録画用サーバーを起動しています", step: 1 },
  recording: { label: "リプレイを録画しています", step: 2 },
  converting: { label: "動画を変換しています", step: 3 },
  done: { label: "録画が完了しました", step: 4 },
  failed: { label: "録画に失敗しました", step: 4 },
};

const STEPS = ["待機", "起動", "録画", "変換", "完了"];

/** 秒数を "m:ss" 形式に整形する。 */
function formatSeconds(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}

export function JobProgress({ jobId }: Props) {
  const { job, loadError } = useJobPolling(jobId);
  return <JobProgressView job={job} loadError={loadError} />;
}

/**
 * ジョブ状態表示の純粋表示部分（ポーリングを持たない）。
 * `dev/JobProgressPlayground.tsx` から実データ無しで各状態を確認するために分離。
 */
export function JobProgressView({ job, loadError }: ViewProps) {
  const status = job?.status ?? "queued";
  const meta = STATUS_META[status];
  const failed = status === "failed";
  const done = status === "done";

  const [downloadingVariant, setDownloadingVariant] = useState<"720p" | "original" | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  async function handleDownload(url: string, variant: "720p" | "original") {
    setDownloadError(null);
    setDownloadingVariant(variant);
    try {
      const filename = buildDownloadFilename(job?.jobId ?? "", job?.replayInfo ?? null, variant);
      await downloadFile(url, filename);
    } catch {
      setDownloadError("ダウンロードに失敗しました。もう一度お試しください。");
    } finally {
      setDownloadingVariant(null);
    }
  }

  return (
    <section className={styles.card}>
      <h1 className={styles.heading}>{meta.label}</h1>

      <ol className={styles.steps} aria-label="録画の進捗">
        {STEPS.map((name, index) => {
          const state =
            failed && index === meta.step
              ? "failed"
              : index < meta.step
                ? "done"
                : index === meta.step
                  ? "active"
                  : "todo";
          return (
            <li key={name} className={styles.step} data-state={state}>
              <span className={styles.dot} />
              <span className={styles.stepLabel}>{name}</span>
            </li>
          );
        })}
      </ol>

      {job?.replayInfo && <ReplayPreview status="ready" info={job.replayInfo} />}

      {!done && !failed && job?.previewImageUrl && (
        <img className={styles.previewImage} src={job.previewImageUrl} alt="録画中のプレビュー" />
      )}

      {!done && !failed && typeof job?.progress === "number" && (
        <div>
          {typeof job.replayInfo?.estimatedDurationSeconds === "number" && (
            <div className={styles.progressBar}>
              <div
                className={styles.progressBarFill}
                style={{
                  width: `${Math.min(100, Math.max(0, (job.progress / job.replayInfo.estimatedDurationSeconds) * 100))}%`,
                }}
              />
            </div>
          )}
          <p className={styles.progressText}>
            {typeof job.replayInfo?.estimatedDurationSeconds === "number"
              ? `${formatSeconds(job.progress)} / ${formatSeconds(job.replayInfo.estimatedDurationSeconds)}`
              : `${formatSeconds(job.progress)} 経過`}
          </p>
        </div>
      )}

      {!done && !failed && <p className={styles.hint}>このページは自動で更新されます。</p>}
      {loadError && <p className={styles.hint}>{loadError}</p>}
      {failed && (
        <p className={styles.error}>
          {job?.error ?? "録画中に問題が発生しました。もう一度お試しください。"}
        </p>
      )}

      {done && downloadError && <p className={styles.error}>{downloadError}</p>}

      {done && (job?.downloadUrl720p ?? job?.downloadUrl) && (
        <button
          type="button"
          className={styles.download}
          disabled={downloadingVariant !== null}
          onClick={() => handleDownload((job?.downloadUrl720p ?? job?.downloadUrl) as string, "720p")}
        >
          {downloadingVariant === "720p" ? "ダウンロード準備中…" : "動画をダウンロード"}
        </button>
      )}

      {done && job?.downloadUrl720p && job?.downloadUrl && (
        <button
          type="button"
          className={styles.secondaryDownload}
          disabled={downloadingVariant !== null}
          onClick={() => handleDownload(job.downloadUrl as string, "original")}
        >
          {downloadingVariant === "original" ? "ダウンロード準備中…" : "元の解像度でダウンロード"}
        </button>
      )}
    </section>
  );
}
