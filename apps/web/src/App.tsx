import { lazy, Suspense, useEffect } from "react";
import clsx from "clsx";
import { useTranslation } from "react-i18next";
import { BrowserRouter, Link, Navigate, Outlet, Route, Routes, useMatch } from "react-router-dom";
import { HomePage } from "./pages/HomePage.tsx";
import { JobPage } from "./pages/JobPage.tsx";
import { AboutPage } from "./pages/AboutPage.tsx";
import { GameInfoPage } from "./pages/GameInfoPage.tsx";
import { TermsPage } from "./pages/TermsPage.tsx";
import { ChangelogPage } from "./pages/ChangelogPage.tsx";
import { ReplayHelpPage } from "./pages/ReplayHelpPage.tsx";
import { ReplayPreviewPlayground } from "./dev/ReplayPreviewPlayground.tsx";
import { JobProgressPlayground } from "./dev/JobProgressPlayground.tsx";
import { MagicLinkSentPlayground } from "./dev/MagicLinkSentPlayground.tsx";
import { LanguageSwitcher } from "./components/LanguageSwitcher.tsx";
import { UploadFormStateContext, useUploadFormPersistedState } from "./components/UploadFormStateContext.ts";
import { useAnalyticsPageview } from "./hooks/useAnalyticsPageview.ts";
import { LocaleContext } from "./i18n/LocaleContext.ts";
import { toLocalizedPath } from "./i18n/paths.ts";
import type { SupportedLanguage } from "./i18n/i18n.ts";
import styles from "./App.module.css";

// 管理画面(`/admin`、Issue #51)。一般ユーザーのバンドルサイズに影響させないよう
// React.lazyで別チャンクに分離する。`lazy()`はdefault exportを要求するため、
// このリポジトリの「名前付きexport」規約(named export)を保ったまま
// `.then((m) => ({ default: m.AdminApp }))`で変換する。
const AdminApp = lazy(() => import("./admin/AdminApp.tsx").then((m) => ({ default: m.AdminApp })));

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

  // Cookie無しのpageview計測（Issue #142）。`/admin/*`は別コンポーネントツリー
  // （`AdminApp`）でこの`Layout`を経由しないため、自然に計測対象から外れる。
  useAnalyticsPageview();

  // ページB（2カラムのリプレイ情報+アクティビティログ）はページAより広い画面幅を活かせるため、
  // ページAの幅(50rem)はそのままにページBのみ最大90remまで広げる。
  const isJobPage = useMatch(lang === "en" ? "/en/jobs/:jobId" : "/jobs/:jobId");
  // ランディングページ(`/`, `/en`)は検索流入の主戦場だが、タグライン以外に見出しが
  // 無く<h1>が1つも存在しなかった(Issue #55)。他ページは各々<h1>を持つため、ここでは
  // ランディングページのときだけタグラインを<h1>にする(二重<h1>を避けるため)。
  const isHomePage = useMatch(lang === "en" ? "/en" : "/");

  // UploadForm（`HomePage`）の入力をここで保持する。react-router-domの遷移では
  // `Layout`自体はアンマウントされないため、`/replay-help`等へ移動してブラウザの
  // 「戻る」で戻ってきても入力が消えない（`UploadFormStateContext.ts`）。
  const uploadFormState = useUploadFormPersistedState();

  return (
    <LocaleContext.Provider value={lang}>
      <div className={styles.page}>
        <LanguageSwitcher />

        <header className={styles.header}>
          <Link className={styles.headerLink} to={toLocalizedPath("/", lang)}>
            {isHomePage ? (
              <h1 className={styles.tagline}>{t("app.tagline")}</h1>
            ) : (
              <p className={styles.tagline}>{t("app.tagline")}</p>
            )}
            <p>
              <picture>
                <source srcSet="/icon-transparent.webp" type="image/webp" />
                <img
                  className={styles.icon}
                  src="/icon-transparent.png"
                  width={72}
                  height={72}
                  fetchPriority="high"
                  alt={t("app.logoAlt")}
                />
              </picture>
              <img
                className={clsx(styles.logo, styles.logoLight)}
                src="/logo-black.svg"
                width={545}
                height={72}
                alt={t("app.wordmarkAlt")}
              />
              <img
                className={clsx(styles.logo, styles.logoDark)}
                src="/logo-white.svg"
                width={545}
                height={72}
                alt={t("app.wordmarkAlt")}
              />
            </p>
          </Link>
        </header>

        <main className={clsx(styles.main, isJobPage && styles.mainWide)}>
          <UploadFormStateContext.Provider value={uploadFormState}>
            <Outlet />
          </UploadFormStateContext.Provider>
        </main>

        <footer className={styles.footer}>
          <nav className={styles.footerNav}>
            <Link to={toLocalizedPath("/about", lang)}>{t("app.footerNav.about")}</Link>
            <Link to={toLocalizedPath("/info", lang)}>{t("app.footerNav.gameInfo")}</Link>
            <Link to={toLocalizedPath("/terms", lang)}>{t("app.footerNav.terms")}</Link>
            <Link to={toLocalizedPath("/changelog", lang)}>{t("app.footerNav.changelog")}</Link>
          </nav>
          <small>{t("app.footer")}</small>
        </footer>

        <small className={styles.easterEgg}>{t("app.easterEgg")}</small>
      </div>
    </LocaleContext.Provider>
  );
}

export function App() {
  // デザイン調整用: `pnpm dev` で `?preview=replay`（ReplayPreview）/`?preview=job`
  // （JobProgress）/`?preview=magicLinkSent`（MagicLinkSent）を付けて開くと各状態を
  // 実データ無しで確認できる（import.meta.env.DEVガードにより本番ビルドには含まれない）。
  const previewParam = import.meta.env.DEV ? new URLSearchParams(window.location.search).get("preview") : null;
  if (previewParam === "replay") {
    return <ReplayPreviewPlayground />;
  }
  if (previewParam === "job") {
    return <JobProgressPlayground />;
  }
  if (previewParam === "magicLinkSent") {
    return <MagicLinkSentPlayground />;
  }

  return (
    <BrowserRouter>
      <Routes>
        {/* 管理画面(`/admin`)。ja/enツリーの catch-all(`<Route path="*">`)より後ろに
            置くと`/admin`が"/"へ即リダイレクトされてしまうため、必ず先に置くこと。
            日本語固定・i18n非適用のため独自のレイアウトを持ち、ja/enどちらのツリーにも
            属さない(LanguageSwitcherが存在しない`/en/admin`へのリンクを出さないため)。 */}
        <Route
          path="/admin/*"
          element={
            <Suspense fallback={<p>読み込み中…</p>}>
              <AdminApp />
            </Suspense>
          }
        />
        {/* ja（既定言語）: プレフィックス無し。バックエンドが生成するマジックリンクは
            `/jobs/{jobId}`固定のため、このツリーは常にプレフィックス無しで到達可能である必要がある。 */}
        <Route path="/" element={<Layout lang="ja" />}>
          <Route index element={<HomePage />} />
          <Route path="jobs/:jobId" element={<JobPage />} />
          <Route path="about" element={<AboutPage />} />
          <Route path="info" element={<GameInfoPage />} />
          <Route path="terms" element={<TermsPage />} />
          <Route path="changelog" element={<ChangelogPage />} />
          <Route path="replay-help" element={<ReplayHelpPage />} />
          {/* 未定義のパスは"/"へ戻す。 */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
        {/* en: "/en"プレフィックス。ja側とツリー構造は同一。 */}
        <Route path="/en" element={<Layout lang="en" />}>
          <Route index element={<HomePage />} />
          <Route path="jobs/:jobId" element={<JobPage />} />
          <Route path="about" element={<AboutPage />} />
          <Route path="info" element={<GameInfoPage />} />
          <Route path="terms" element={<TermsPage />} />
          <Route path="changelog" element={<ChangelogPage />} />
          <Route path="replay-help" element={<ReplayHelpPage />} />
          <Route path="*" element={<Navigate to="/en" replace />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
