import { useEffect, useState } from "react";
import { confirmJob, resendMagicLink, SattoriApiError } from "../api/client.ts";
import styles from "./ConfirmMagicLink.module.css";

interface Props {
  jobId: string;
  token: string;
  onConfirmed: (jobId: string) => void;
}

type State =
  | { phase: "confirming" }
  | { phase: "error"; message: string }
  | { phase: "resent" };

/**
 * マジックリンク先（メールのリンククリック直後）に表示する画面。
 * マウント時に自動でトークンを確認し、成功したら録画が起動して JobProgress へ引き継ぐ
 * （ページBそのものの作り込み・完了メール等はIssue #10）。
 */
export function ConfirmMagicLink({ jobId, token, onConfirmed }: Props) {
  const [state, setState] = useState<State>({ phase: "confirming" });

  useEffect(() => {
    let cancelled = false;
    confirmJob(jobId, token)
      .then((result) => {
        if (!cancelled) {
          onConfirmed(result.jobId);
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
    // jobId/token はページ表示中に変わらない前提（URLから一度だけ読み取る）。
  }, [jobId, token, onConfirmed]);

  async function handleResend() {
    try {
      await resendMagicLink(jobId, token);
      setState({ phase: "resent" });
    } catch (err) {
      const message =
        err instanceof SattoriApiError ? err.message : "予期しないエラーが発生しました";
      setState({ phase: "error", message });
    }
  }

  if (state.phase === "confirming") {
    return (
      <section className={styles.card}>
        <p>録画を開始しています…</p>
      </section>
    );
  }

  if (state.phase === "resent") {
    return (
      <section className={styles.card}>
        <p>新しいリンクを送信しました。メールをご確認ください。</p>
      </section>
    );
  }

  return (
    <section className={styles.card}>
      <p className={styles.error}>{state.message}</p>
      <button type="button" className={styles.resend} onClick={handleResend}>
        リンクを再送する
      </button>
    </section>
  );
}
