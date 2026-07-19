import { useEffect, useState } from "react";
import { startJob, SattoriApiError } from "../api/client.ts";
import styles from "./StartJob.module.css";

interface Props {
  jobId: string;
  onStarted: (jobId: string) => void;
  onReset: () => void;
}

type State = { phase: "starting" } | { phase: "error"; message: string };

/**
 * ジョブページ（メールのリンク先）に表示する画面。マウント時に自動で録画開始を
 * 要求し（jobIdのみで認可、tokenは無い）、成功したら JobProgress へ引き継ぐ。
 * 既に起動済みのジョブへ再アクセスした場合も冪等に成功として扱われ、そのまま
 * 進捗表示へ進む（ページBそのものの作り込みはIssue #10）。
 */
export function StartJob({ jobId, onStarted, onReset }: Props) {
  const [state, setState] = useState<State>({ phase: "starting" });

  useEffect(() => {
    let cancelled = false;
    startJob(jobId)
      .then((result) => {
        if (!cancelled) {
          onStarted(result.jobId);
        }
      })
      .catch((err) => {
        if (cancelled) {
          return;
        }
        const message =
          err instanceof SattoriApiError ? err.message : "予期しないエラーが発生しました";
        setState({ phase: "error", message });
      });
    return () => {
      cancelled = true;
    };
  }, [jobId, onStarted]);

  if (state.phase === "starting") {
    return (
      <section className={styles.card}>
        <p>録画を開始しています…</p>
      </section>
    );
  }

  return (
    <section className={styles.card}>
      <p className={styles.error}>{state.message}</p>
      <button type="button" className={styles.reset} onClick={onReset}>
        最初からやり直す
      </button>
    </section>
  );
}
