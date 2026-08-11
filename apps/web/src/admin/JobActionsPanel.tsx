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
 * - **緊急停止**: `done` 以外のジョブで有効。Step Functions実行の停止・EC2
 *   インスタンスのterminate・`failed`への確定をAPI側が一括で行う。**`failed` でも
 *   押せる**ようにしているのは、ワーカーが`SendTaskFailure`より先に`failed`を書く
 *   ため「statusはfailedなのにステートマシンはリトライを続けている（＝新しいEC2が
 *   起動し続ける）」状態がありうるため。止められるかどうかの最終判断はAPI側が
 *   Step Functionsの実行状態を見て行い、本当に止めるものが無ければ409を返す。
 * - **再実行**: 終端状態（`done`/`failed`）かつ未再実行のジョブでのみ有効。元ジョブは
 *   変更せず、新しいjobIdのジョブを複製して起動する（同一jobIdでの再実行は既存の
 *   冪等性前提を壊すため。`apps/api/src/handlers/admin/retryJob.ts`参照）。
 *
 * どちらも取り返しのつかない操作（EC2の強制終了・新規インスタンス起動による課金）
 * なので、`window.confirm`による確認を必須にしている。
 *
 * 文言は`workerKind`で出し分ける（Issue #49）。自宅ワーカーが実行したジョブに
 * 「EC2インスタンスを強制終了し」「課金が発生します」と出すのは端的に誤りで、
 * 停止の効き方（terminateで即座に止まるEC2 / claim解除に気づくまで最大30秒走り続ける
 * 自宅ワーカー）まで違う。
 */
export function JobActionsPanel({ job, onJobChanged }: Props) {
  const { token, onUnauthorized } = useAdminAuth();
  const [running, setRunning] = useState<"stop" | "retry" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [retriedJobId, setRetriedJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const terminal = isTerminalStatus(job.status);
  // `failed`は「実行も終わっている」ことを意味しない（上のコメント参照）ため、
  // 停止を無効化する条件は`done`のみに絞る。
  const stoppable = job.status !== "done";
  // 再実行済みのジョブをもう一度再実行すると、同じリプレイを録画するジョブが
  // 二重に走る。API側も原子的に排他するが、UIでも押せないようにしておく。
  const alreadyRetried = job.retriedToJobId !== null;
  const isHomeWorker = job.workerKind === "home";
  // 割り当て前（`workerKind`がnull）のジョブは、これからEC2・自宅のどちらで走るか
  // 決まっていないため、どちらとも取れる言い方にする。
  const workerLabel = isHomeWorker
    ? "自宅ワーカーのコンテナ"
    : job.workerKind === "ec2"
      ? "EC2インスタンス"
      : "ワーカー（EC2インスタンスまたは自宅ワーカーのコンテナ）";

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
      `ジョブ ${job.jobId} を緊急停止します。実行中の${workerLabel}は停止され、録画結果は失われます。よろしいですか？`,
    );
    if (!confirmed) {
      return;
    }
    run("stop", async () => {
      const result = await stopAdminJob(token, job.jobId);
      setMessage(
        `停止しました（Step Functions実行: ${result.executionStopped ? "停止済み" : "対象なし"} / EC2インスタンス: ${result.instanceTerminated ? "終了要求済み" : "対象なし"} / 自宅ワーカー: ${result.homeWorkerReleased ? "割り当て解除済み" : "対象なし"}）${
          // 停止処理中にワーカーが完走していた場合、APIは確定済みの`done`を
          // `failed`で上書きしない（`AdminStopJobResponse.status`参照）。
          result.status === "done" ? "。停止処理中に録画が完了したため、statusはdoneのままです" : ""
        }`,
      );
      onJobChanged();
    });
  };

  const handleRetry = () => {
    // 再実行は`workerKind: null`の新しいジョブを作るため（`retryJob.ts`）、元ジョブが
    // 自宅ワーカーで走っていたとしても、割り当ては改めて決まる（＝EC2が起動しうる）。
    const confirmed = window.confirm(
      `ジョブ ${job.jobId} を新しいジョブとして再実行します。自宅ワーカーが空いていなければEC2インスタンスが起動し、課金が発生します。よろしいですか？`,
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
          disabled={!stoppable || running !== null}
        >
          {running === "stop" ? "停止中…" : "緊急停止"}
        </button>
        <button
          type="button"
          className={styles.button}
          onClick={handleRetry}
          disabled={!terminal || alreadyRetried || running !== null}
        >
          {running === "retry" ? "再実行中…" : "再実行"}
        </button>
      </div>
      <p className={styles.note}>
        {terminal
          ? "終了済みのジョブです。再実行すると新しいjobIdのジョブとして複製・起動されます（元ジョブは変更されません）。"
          : isHomeWorker
            ? "実行中のジョブです。緊急停止すると自宅ワーカーへの割り当てを解除し、statusをfailedに確定します（コンテナはデーモンが解除に気づくまで最大30秒走り続けますが、その結果がジョブへ書き戻されることはありません）。"
            : `実行中のジョブです。緊急停止すると${workerLabel}を強制終了し、statusをfailedに確定します。`}
      </p>
      {alreadyRetried && (
        <p className={styles.note}>
          このジョブは既に再実行済みです（二重録画を避けるため再実行できません）。さらに再実行する場合は再実行先のジョブから行ってください。
        </p>
      )}
      {job.status === "failed" && (
        <p className={styles.note}>
          statusがfailedでも、Step
          Functionsがリトライ中で新しいワーカー（EC2または自宅）が起動し続けていることがあります（ワーカーは実行の終了より先にfailedを記録するため）。実行状態は下の「Step
          Functions実行」で確認でき、まだ動いていれば緊急停止できます。
        </p>
      )}
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
