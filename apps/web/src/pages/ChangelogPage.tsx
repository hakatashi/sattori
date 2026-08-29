import { useTranslation } from "react-i18next";
import { type ChangelogEntry, changelogEntries } from "../data/changelog.ts";
import { useLocale } from "../i18n/LocaleContext.ts";
import staticStyles from "./StaticPage.module.css";
import styles from "./ChangelogPage.module.css";

interface ChangelogGroup {
  date: string;
  entries: ChangelogEntry[];
}

/** 日付が変わるごとに区切ったグループへまとめる（同日の複数エントリを1つの日付見出し下に表示するため）。 */
export function groupByDate(entries: ChangelogEntry[]): ChangelogGroup[] {
  const groups: ChangelogGroup[] = [];
  for (const entry of entries) {
    const lastGroup = groups.at(-1);
    if (lastGroup?.date === entry.date) {
      lastGroup.entries.push(entry);
    } else {
      groups.push({ date: entry.date, entries: [entry] });
    }
  }
  return groups;
}

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
      <ul className={styles.list}>
        {groupByDate(changelogEntries).map((group) => (
          <li key={group.date} className={styles.entry}>
            <p className={styles.date}>
              <time dateTime={group.date}>{dateFormat.format(new Date(group.date))}</time>
            </p>
            <ul className={styles.descriptionList}>
              {group.entries.map((entry) => (
                <li
                  key={entry.ja}
                  className={entry.important ? styles.descriptionImportant : styles.description}
                >
                  {entry[lang]}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </section>
  );
}
