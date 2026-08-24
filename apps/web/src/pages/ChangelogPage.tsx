import { useTranslation } from "react-i18next";
import { changelogEntries } from "../data/changelog.ts";
import { useLocale } from "../i18n/LocaleContext.ts";
import staticStyles from "./StaticPage.module.css";
import styles from "./ChangelogPage.module.css";

/** 更新履歴ページ（`/changelog`）。フッターからナビゲーションする。 */
export function ChangelogPage() {
  const { t } = useTranslation();
  const lang = useLocale();
  const dateFormat = new Intl.DateTimeFormat(lang === "ja" ? "ja-JP" : "en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  return (
    <section className={staticStyles.card}>
      <h1 className={staticStyles.heading}>{t("changelog.heading")}</h1>
      <p>{t("changelog.description")}</p>
      <ul className={styles.list}>
        {changelogEntries.map((entry) => (
          <li key={`${entry.date}-${entry.ja}`} className={styles.entry}>
            <p className={styles.date}>
              <time dateTime={entry.date}>{dateFormat.format(new Date(entry.date))}</time>
            </p>
            <p className={styles.description}>
              {entry[lang]}
              {entry.issueUrl && (
                <>
                  {" "}
                  <a href={entry.issueUrl} target="_blank" rel="noopener noreferrer">
                    ({t("changelog.detailsLink")})
                  </a>
                </>
              )}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}
