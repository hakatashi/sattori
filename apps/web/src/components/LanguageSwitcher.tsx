import { useTranslation } from "react-i18next";
import { Link, useLocation } from "react-router-dom";
import clsx from "clsx";
import { SUPPORTED_LANGUAGES } from "../i18n/i18n.ts";
import { useLocale } from "../i18n/LocaleContext.ts";
import { toLocalizedPath } from "../i18n/paths.ts";
import styles from "./LanguageSwitcher.module.css";

/** 現在のパスを保ったまま言語を切り替えるボタン群。ヘッダー右上に常時表示する。 */
export function LanguageSwitcher() {
  const { t } = useTranslation();
  const lang = useLocale();
  const location = useLocation();

  return (
    <nav className={styles.switcher} aria-label={t("app.languageSwitcher.label")}>
      {SUPPORTED_LANGUAGES.map((candidate) => (
        <Link
          key={candidate}
          to={toLocalizedPath(location.pathname, candidate)}
          className={clsx(styles.option, candidate === lang && styles.active)}
          aria-current={candidate === lang ? "true" : undefined}
        >
          {t(`app.languageSwitcher.${candidate}`)}
        </Link>
      ))}
    </nav>
  );
}
