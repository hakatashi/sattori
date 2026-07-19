import { BrowserRouter, Navigate, Outlet, Route, Routes } from "react-router-dom";
import { HomePage } from "./pages/HomePage.tsx";
import { JobPage } from "./pages/JobPage.tsx";
import { ReplayPreviewPlayground } from "./dev/ReplayPreviewPlayground.tsx";
import styles from "./App.module.css";

/** 共通のヘッダー・フッター。ルートごとの画面は `<Outlet />` に差し込まれる。 */
function Layout() {
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
        <Outlet />
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

export function App() {
  // デザイン調整用: `pnpm dev` で `?preview=replay` を付けて開くとReplayPreviewの
  // 各状態を実データ無しで確認できる（import.meta.env.DEVガードにより本番ビルドには含まれない）。
  if (import.meta.env.DEV && new URLSearchParams(window.location.search).get("preview") === "replay") {
    return <ReplayPreviewPlayground />;
  }

  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<HomePage />} />
          <Route path="jobs/:jobId" element={<JobPage />} />
          {/* 未定義のパスは"/"へ戻す(将来 /about, /en/... 等を追加後は個別のRouteに置き換える)。 */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
