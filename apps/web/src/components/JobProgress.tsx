import clsx from "clsx";
import { useTranslation } from "react-i18next";
import type { GetJobResponse, JobStatus } from "@sattori/shared";
import { useEstimatedProgress } from "../hooks/useEstimatedProgress.ts";
import { useJobPolling } from "../hooks/useJobPolling.ts";
import { useOverallProgress } from "../hooks/useOverallProgress.ts";
import { translateJobError } from "../i18n/apiErrors.ts";
import { ReplayPreview } from "./ReplayPreview.tsx";
import styles from "./JobProgress.module.css";

interface Props {
  jobId: string;
}

interface ViewProps {
  job: GetJobResponse | null;
  loadError: string | null;
}

/** 各ステータスのユーザー向け表示文言（jobProgress.status.*）と進捗段階（0..4）。 */
const STATUS_STEP: Record<JobStatus, number> = {
  pending: 0,
  queued: 0,
  launching: 1,
  recording: 2,
  converting: 3,
  done: 4,
  failed: 4,
};

/** 秒数を "m:ss" 形式に整形する。 */
function formatSeconds(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}

/** ダウンロード期限（ISO 8601）を表示用の日時文字列に整形する。 */
function formatExpiresAt(isoString: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(isoString),
  );
}

export function JobProgress({ jobId }: Props) {
  const { job, loadError } = useJobPolling(jobId);
  return <JobProgressView job={job} loadError={loadError} />;
}

/**
 * ジョブ状態表示の純粋表示部分（ポーリングを持たない）。
 * `dev/JobProgressPlayground.tsx` から実データ無しで各状態を確認するために分離。
 * レイアウトは Claude Design 案「JobProgress 再設計案 1c」準拠
 * （リプレイ情報カード + アクティビティログの2カラム構成）。
 */
export function JobProgressView({ job, loadError }: ViewProps) {
  const { t, i18n } = useTranslation();
  // ポーリングは3秒間隔のため、その間の進捗はサーバー値からの実時間経過をもとに推定する
  // （録画中であることが体感できるよう、数値が滑らかに動き続ける必要があるため）。
  const progress = useEstimatedProgress(job);
  // pending〜done全体の進捗(%)と悲観的な残り時間の見積もり。progressの二重計算を避けるため
  // useEstimatedProgressの戻り値をそのまま渡す。
  const overall = useOverallProgress(job, progress);
  const steps = t("jobProgress.steps", { returnObjects: true }) as string[];

  // 初回ロード中（jobが未取得）はステータス別の表示を仮定せず、中立的な読み込み中表示に留める。
  // 既に完了しているジョブでも「準備をしています」等が一瞬表示されて紛らわしくなるのを防ぐ。
  if (!job) {
    return (
      <section className={styles.card}>
        <h1 className={styles.heading}>{t("jobProgress.loading")}</h1>
        {loadError && <p className={styles.hint}>{loadError}</p>}
      </section>
    );
  }

  const status = job.status;
  const step = STATUS_STEP[status];
  const failed = status === "failed";
  const done = status === "done";
  const showProgress = typeof progress === "number" && !done && !failed;
  const estimatedDurationSeconds = job.replayInfo?.estimatedDurationSeconds ?? null;

  return (
    <section className={styles.card}>
      <h1 className={styles.heading}>{t(`jobProgress.status.${status}`)}</h1>
      {loadError && <p className={styles.hint}>{loadError}</p>}

      {!failed && (
        <div className={styles.overallProgress}>
          <div
            className={styles.overallProgressBar}
            role="progressbar"
            aria-label={t("jobProgress.overallProgressAriaLabel")}
            aria-valuenow={Math.round(overall.percent)}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div className={styles.overallProgressFill} style={{ width: `${overall.percent}%` }} />
          </div>
          <div className={styles.overallProgressMeta}>
            <span>{Math.round(overall.percent)}%</span>
            {overall.remainingMinutes !== null && (
              <span>{t("jobProgress.etaMinutes", { minutes: overall.remainingMinutes })}</span>
            )}
            {/*
              低速録画(Issue #68)は録画に実時間で2倍かかる。残り時間の見積もりには
              織り込んであるが、他のジョブと比べて明らかに長いことの説明が無いと
              「止まっているのでは」と受け取られるため、理由をその場に出しておく。
            */}
            {job.slowMotion && !done && (
              <span className={styles.slowMotionHint}>{t("jobProgress.slowMotionHint")}</span>
            )}
            {overall.retrySuspected && (
              <span className={styles.retryHint}>{t("jobProgress.retryHint")}</span>
            )}
          </div>
        </div>
      )}

      <div className={clsx(styles.grid, !job.replayInfo && styles.gridSingle)}>
        {job.replayInfo && (
          <div className={styles.replayCard}>
            <ReplayPreview status="ready" info={job.replayInfo} />
          </div>
        )}

        <div className={styles.logCard}>
          <ol className={styles.logList} aria-label={t("jobProgress.progressAriaLabel")}>
            {steps.map((name, index) => {
              const state =
                failed && index === step
                  ? "failed"
                  : index < step
                    ? "done"
                    : index === step
                      ? "active"
                      : "todo";
              const showDetail = showProgress && index === step && typeof progress === "number";

              return (
                <li key={name} className={styles.logItem} data-state={state}>
                  <span className={styles.logDot} />
                  <div className={styles.logContent}>
                    <p className={styles.logName}>{name}</p>
                    {showDetail && typeof progress === "number" && (
                      <div className={styles.logDetail}>
                        {job.previewImageUrl && status !== "converting" && (
                          <img
                            className={styles.logThumbnail}
                            src={job.previewImageUrl}
                            alt={t("jobProgress.previewAlt")}
                          />
                        )}
                        <div className={styles.logProgressWrap}>
                          {estimatedDurationSeconds === null ? (
                            <p className={styles.logProgressText}>
                              {t("jobProgress.elapsed", { time: formatSeconds(progress) })}
                            </p>
                          ) : (
                            <>
                              <div className={styles.logProgressBar}>
                                <div
                                  className={styles.logProgressFill}
                                  style={{
                                    width: `${Math.min(100, Math.max(0, (progress / estimatedDurationSeconds) * 100))}%`,
                                  }}
                                />
                              </div>
                              <p className={styles.logProgressText}>
                                {formatSeconds(progress)} / {formatSeconds(estimatedDurationSeconds)}
                              </p>
                            </>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>

          {failed && (
            <p className={styles.error}>
              {job.error ? translateJobError(t, job.error) : t("jobProgress.genericError")}
            </p>
          )}

          {done && job.previewVideoUrl && (
            <figure className={styles.preview}>
              {/*
                プレビュー再生（Issue #71）。動画1本の平均が720p版で約1GiBあり、
                CloudFrontの常時無料枠(1TB/月)を月1000録画でほぼ使い切る水準にある
                （`docs/aws-region-cost-analysis.md` §6）ため、配信量を増やさないことを
                最優先にしている:
                - `preload="none"`: 再生ボタンを押すまで1バイトも取得させない
                  （既定の`metadata`はページを開いただけでmoov atomの取得が走る）。
                  再生前に真っ黒な矩形にならないよう、代わりに録画中スクリーンショットを
                  `poster`（数十KB）として使う。
                - 再生後はブラウザがRangeリクエストで必要な分だけ先読みし、十分
                  バッファできた時点で受信を止める（S3/CloudFrontともRange対応）。
                  途中まで見て閉じれば、その分の転送量しか発生しない。
                - `autoPlay`は付けない（意図しない全編ダウンロードを避ける）。
              */}
              <video
                className={styles.previewVideo}
                src={job.previewVideoUrl}
                poster={job.previewImageUrl ?? undefined}
                controls
                preload="none"
                playsInline
                aria-label={t("jobProgress.previewVideoLabel")}
              />
            </figure>
          )}

          {done && (job.downloadUrl720p ?? job.downloadUrl) && (
            <div className={styles.doneActions}>
              {job.downloadExpiresAt && (
                <p className={styles.downloadExpiresAt}>
                  {t("jobProgress.downloadExpiresAt", {
                    date: formatExpiresAt(job.downloadExpiresAt, i18n.language),
                  })}
                </p>
              )}
              <div className={styles.downloadButtons}>
                <div className={styles.spacer} />
                <a
                  className={styles.download}
                  href={job.downloadUrl720p ?? job.downloadUrl ?? undefined}
                  download
                >
                  {t("jobProgress.download")}
                </a>
                {job.downloadUrl720p && job.downloadUrl && (
                  <a className={styles.secondaryDownload} href={job.downloadUrl} download>
                    {t("jobProgress.downloadOriginal")}
                  </a>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {!done && !failed && (
        <p className={styles.hint}>
          {t("jobProgress.hint")}
        </p>
      )}
    </section>
  );
}
