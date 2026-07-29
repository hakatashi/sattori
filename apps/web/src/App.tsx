import { useEffect } from "react";
import clsx from "clsx";
import { useTranslation } from "react-i18next";
import { BrowserRouter, Link, Navigate, Outlet, Route, Routes, useMatch } from "react-router-dom";
import { HomePage } from "./pages/HomePage.tsx";
import { JobPage } from "./pages/JobPage.tsx";
import { ReplayPreviewPlayground } from "./dev/ReplayPreviewPlayground.tsx";
import { JobProgressPlayground } from "./dev/JobProgressPlayground.tsx";
import { LanguageSwitcher } from "./components/LanguageSwitcher.tsx";
import { LocaleContext } from "./i18n/LocaleContext.ts";
import { toLocalizedPath } from "./i18n/paths.ts";
import type { SupportedLanguage } from "./i18n/i18n.ts";
import styles from "./App.module.css";

interface LayoutProps {
  lang: SupportedLanguage;
}

/**
 * 共通のヘッダー・フッター。ルートごとの画面は `<Outlet />` に差し込まれる。
 * `lang`はURL（"/" = ja, "/en" = en）から親の`<Route>`経由で渡され、
 * 配下のページ・コンポーネントはこの言語で描画する（`LocaleContext`）。
 */
function Layout({ lang }: LayoutProps) {
  const { t, i18n } = useTranslation();
  // 言語はURLパスのみで決まる（ブラウザ検出はしない）。マジックリンクメールのURLは
  // バックエンド側で`/jobs/{jobId}`固定生成のため、既定言語(ja)は常にプレフィックス無しで
  // 到達できる必要がある（apps/api/src/ses.ts）。
  useEffect(() => {
    void i18n.changeLanguage(lang);
  }, [lang, i18n]);

  // ページB（2カラムのリプレイ情報+アクティビティログ）はページAより広い画面幅を活かせるため、
  // ページAの幅(50rem)はそのままにページBのみ最大90remまで広げる。
  const isJobPage = useMatch(lang === "en" ? "/en/jobs/:jobId" : "/jobs/:jobId");

  return (
    <LocaleContext.Provider value={lang}>
      <div className={styles.page}>
        <LanguageSwitcher />

        <header className={styles.header}>
          <Link className={styles.headerLink} to={toLocalizedPath("/", lang)}>
            <p className={styles.tagline}>{t("app.tagline")}</p>
            <p>
              <img className={styles.icon} src="/icon-transparent.png" alt={t("app.logoAlt")} />
              <img
                className={clsx(styles.logo, styles.logoLight)}
                src="/logo-black.svg"
                alt={t("app.wordmarkAlt")}
              />
              <img
                className={clsx(styles.logo, styles.logoDark)}
                src="/logo-white.svg"
                alt={t("app.wordmarkAlt")}
              />
            </p>
          </Link>
        </header>

        <main className={clsx(styles.main, isJobPage && styles.mainWide)}>
          <Outlet />
        </main>

        <footer className={styles.footer}>
          <small>{t("app.footer")}</small>
        </footer>

        <small className={styles.easterEgg}>{t("app.easterEgg")}</small>
      </div>
    </LocaleContext.Provider>
  );
}

export function App() {
  // デザイン調整用: `pnpm dev` で `?preview=replay`（ReplayPreview）/`?preview=job`
  // （JobProgress）を付けて開くと各状態を実データ無しで確認できる
  // （import.meta.env.DEVガードにより本番ビルドには含まれない）。
  const previewParam = import.meta.env.DEV ? new URLSearchParams(window.location.search).get("preview") : null;
  if (previewParam === "replay") {
    return <ReplayPreviewPlayground />;
  }
  if (previewParam === "job") {
    return <JobProgressPlayground />;
  }

  return (
    <BrowserRouter>
      <Routes>
        {/* ja（既定言語）: プレフィックス無し。バックエンドが生成するマジックリンクは
            `/jobs/{jobId}`固定のため、このツリーは常にプレフィックス無しで到達可能である必要がある。 */}
        <Route path="/" element={<Layout lang="ja" />}>
          <Route index element={<HomePage />} />
          <Route path="jobs/:jobId" element={<JobPage />} />
          {/* 未定義のパスは"/"へ戻す。 */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
        {/* en: "/en"プレフィックス。ja側とツリー構造は同一。 */}
        <Route path="/en" element={<Layout lang="en" />}>
          <Route index element={<HomePage />} />
          <Route path="jobs/:jobId" element={<JobPage />} />
          <Route path="*" element={<Navigate to="/en" replace />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
