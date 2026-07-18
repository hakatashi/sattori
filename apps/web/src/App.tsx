import { useState } from "react";
import { UploadForm } from "./components/UploadForm.tsx";
import { JobProgress } from "./components/JobProgress.tsx";
import styles from "./App.module.css";

/**
 * フェーズ1の最小フロー。
 * 1. リプレイをアップロードして録画ジョブを起動（UploadForm）
 * 2. ジョブの進捗を表示し、完了後にダウンロード（JobProgress）
 *
 * メール認証・リプレイ解析プレビュー・ページA/Bのメール分離はフェーズ2で追加する。
 */
export function App() {
  const [jobId, setJobId] = useState<string | null>(null);

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
        {jobId === null ? (
          <UploadForm onJobStarted={setJobId} />
        ) : (
          <JobProgress jobId={jobId} onReset={() => setJobId(null)} />
        )}
      </main>

      <footer className={styles.footer}>
        <small>
          Sattori はファンメイドの非公式サービスです。東方Project © 上海アリス幻樂団
        </small>
      </footer>
    </div>
  );
}
