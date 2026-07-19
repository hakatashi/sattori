import { useState } from "react";
import { UploadForm } from "./components/UploadForm.tsx";
import { MagicLinkSent } from "./components/MagicLinkSent.tsx";
import { StartJob } from "./components/StartJob.tsx";
import { JobProgress } from "./components/JobProgress.tsx";
import { ReplayPreviewPlayground } from "./dev/ReplayPreviewPlayground.tsx";
import styles from "./App.module.css";

/**
 * ページAの初期状態。マジックリンクのメール（`?jobId=...`）から開いた場合は
 * "starting" から始まり、起動が成功すると "progress" へ遷移する（Issue #9）。
 * jobIdはメールを確認しないと分からない秘密値として機能するため、URLには
 * jobId以外の認可情報（token等）は含まない。
 * リッチなページB体験（完了メール再送・エラー導線の作り込み等）はIssue #10で拡張する。
 */
function initialViewFromLocation(): View {
  const params = new URLSearchParams(window.location.search);
  const jobId = params.get("jobId");
  if (jobId) {
    return { kind: "starting", jobId };
  }
  return { kind: "upload" };
}

type View =
  | { kind: "upload" }
  | { kind: "starting"; jobId: string }
  | { kind: "sent"; email: string }
  | { kind: "progress"; jobId: string };

export function App() {
  const [view, setView] = useState<View>(initialViewFromLocation);

  // デザイン調整用: `pnpm dev` で `?preview=replay` を付けて開くとReplayPreviewの
  // 各状態を実データ無しで確認できる（import.meta.env.DEVガードにより本番ビルドには含まれない）。
  if (import.meta.env.DEV && new URLSearchParams(window.location.search).get("preview") === "replay") {
    return <ReplayPreviewPlayground />;
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <p className={styles.tagline}>東方リプレイ自動録画サービス</p>
        <p>
          <img className={styles.icon} src="/icon-transparent.png" alt="Sattori logo" />
          <img className={styles.logo} src="/logo-black.svg" alt="TouhouSattori" />
        </p>
      </header>

      <main className={styles.main}>
        {view.kind === "upload" && (
          <UploadForm onMagicLinkSent={(email) => setView({ kind: "sent", email })} />
        )}
        {view.kind === "sent" && (
          <MagicLinkSent email={view.email} onReset={() => setView({ kind: "upload" })} />
        )}
        {view.kind === "starting" && (
          <StartJob
            jobId={view.jobId}
            onStarted={(jobId) => setView({ kind: "progress", jobId })}
          />
        )}
        {view.kind === "progress" && (
          <JobProgress jobId={view.jobId} onReset={() => setView({ kind: "upload" })} />
        )}
      </main>

      <footer className={styles.footer}>
        <small>
          Sattori はファンメイドの非公式サービスです。東方Project © 上海アリス幻樂団
        </small>
      </footer>

      <small className={styles.easterEgg}>
        「10点満点中、11点のサービスです」――とある館の主
      </small>
    </div>
  );
}
