import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { startJob, SattoriApiError } from "../api/client.ts";
import { translateApiErrorMessage } from "../i18n/apiErrors.ts";
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
  const { t } = useTranslation();
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
          err instanceof SattoriApiError
            ? translateApiErrorMessage(t, err.code, err.message, { status: err.status })
            : t("startJob.unexpectedError");
        setState({ phase: "error", message });
      });
    return () => {
      cancelled = true;
    };
  }, [jobId, onStarted, t]);

  if (state.phase === "starting") {
    return (
      <section className={styles.card}>
        <p>{t("startJob.loading")}</p>
      </section>
    );
  }

  return (
    <section className={styles.card}>
      <p className={styles.error}>{state.message}</p>
      <button type="button" className={styles.reset} onClick={onReset}>
        {t("startJob.retry")}
      </button>
    </section>
  );
}
