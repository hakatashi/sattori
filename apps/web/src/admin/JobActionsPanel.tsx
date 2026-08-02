import { useState } from "react";
import { Link } from "react-router-dom";
import { isTerminalStatus, type JobRecord } from "@sattori/shared";
import { AdminUnauthorizedError, retryAdminJob, stopAdminJob } from "./adminApi.ts";
import { useAdminAuth } from "./AdminAuthContext.ts";
import styles from "./JobActionsPanel.module.css";

interface Props {
  job: JobRecord;
  /** 停止・再実行でジョブレコードが変化したことを詳細画面へ知らせる（再取得用）。 */
  onJobChanged: () => void;
}

/**
 * ジョブ詳細画面の操作パネル（Issue #59）。
 *
 * - **緊急停止**: 非終端状態のジョブでのみ有効。Step Functions実行の停止・EC2
 *   インスタンスのterminate・`failed`への確定をAPI側が一括で行う。
 * - **再実行**: 終端状態（`done`/`failed`）のジョブでのみ有効。元ジョブは変更せず、
 *   新しいjobIdのジョブを複製して起動する（同一jobIdでの再実行は既存の冪等性前提を
 *   壊すため。`apps/api/src/handlers/admin/retryJob.ts`参照）。
 *
 * どちらも取り返しのつかない操作（EC2の強制終了・新規インスタンス起動による課金）
 * なので、`window.confirm`による確認を必須にしている。
 */
export function JobActionsPanel({ job, onJobChanged }: Props) {
  const { token, onUnauthorized } = useAdminAuth();
  const [running, setRunning] = useState<"stop" | "retry" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [retriedJobId, setRetriedJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const terminal = isTerminalStatus(job.status);

  /** 2つの操作で共通の、実行中フラグ・エラー整形・401/403からの復帰処理。 */
  const run = (action: "stop" | "retry", perform: () => Promise<void>) => {
    setRunning(action);
    setMessage(null);
    setRetriedJobId(null);
    setError(null);
    void perform()
      .catch((err: unknown) => {
        if (err instanceof AdminUnauthorizedError) {
          onUnauthorized();
          return;
        }
        setError(err instanceof Error ? err.message : "不明なエラーが発生しました");
      })
      .finally(() => {
        setRunning(null);
      });
  };

  const handleStop = () => {
    const confirmed = window.confirm(
      `ジョブ ${job.jobId} を緊急停止します。実行中のEC2インスタンスは強制終了され、録画結果は失われます。よろしいですか？`,
    );
    if (!confirmed) {
      return;
    }
    run("stop", async () => {
      const result = await stopAdminJob(token, job.jobId);
      setMessage(
        `停止しました（Step Functions実行: ${result.executionStopped ? "停止済み" : "対象なし"} / EC2インスタンス: ${result.instanceTerminated ? "終了要求済み" : "対象なし"}）`,
      );
      onJobChanged();
    });
  };

  const handleRetry = () => {
    const confirmed = window.confirm(
      `ジョブ ${job.jobId} を新しいジョブとして再実行します。EC2インスタンスが起動し課金が発生します。よろしいですか？`,
    );
    if (!confirmed) {
      return;
    }
    run("retry", async () => {
      const result = await retryAdminJob(token, job.jobId);
      setMessage("新しいジョブを起動しました:");
      setRetriedJobId(result.jobId);
      onJobChanged();
    });
  };

  return (
    <>
      <div className={styles.actions}>
        <button
          type="button"
          className={`${styles.button} ${styles.stopButton}`}
          onClick={handleStop}
          disabled={terminal || running !== null}
        >
          {running === "stop" ? "停止中…" : "緊急停止"}
        </button>
        <button
          type="button"
          className={styles.button}
          onClick={handleRetry}
          disabled={!terminal || running !== null}
        >
          {running === "retry" ? "再実行中…" : "再実行"}
        </button>
      </div>
      <p className={styles.note}>
        {terminal
          ? "終了済みのジョブです。再実行すると新しいjobIdのジョブとして複製・起動されます（元ジョブは変更されません）。"
          : "実行中のジョブです。緊急停止するとEC2インスタンスを強制終了し、statusをfailedに確定します。"}
      </p>
      {message && (
        <p className={styles.result}>
          {message}
          {retriedJobId && (
            <Link to={`/admin/jobs/${encodeURIComponent(retriedJobId)}`}>{retriedJobId}</Link>
          )}
        </p>
      )}
      {error && <p className={styles.error}>{error}</p>}
    </>
  );
}
