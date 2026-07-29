import { useTranslation } from "react-i18next";
import staticStyles from "./StaticPage.module.css";
import styles from "./AboutPage.module.css";

/** サービス概要・作者紹介ページ（`/about`）。フッターからナビゲーションする。 */
export function AboutPage() {
  const { t } = useTranslation();
  const intro = t("about.intro", { returnObjects: true }) as string[];

  return (
    <section className={staticStyles.card}>
      <h1 className={staticStyles.heading}>{t("about.heading")}</h1>
      {intro.map((paragraph) => (
        <p key={paragraph}>{paragraph}</p>
      ))}
      <p className={staticStyles.disclaimer}>{t("about.disclaimer")}</p>

      <h2>{t("about.authorHeading")}</h2>
      <div className={styles.author}>
        <img
          className={styles.authorIcon}
          src="https://raw.githubusercontent.com/hakatashi/icon/master/images/icon_480px.png"
          alt="hakatashi"
        />
        <dl className={styles.authorInfo}>
          <dt>{t("about.authorName")}</dt>
          <dd>hakatashi</dd>
          <dt>{t("about.authorRace")}</dt>
          <dd>{t("about.authorRaceValue")}</dd>
          <dt>{t("about.authorAbility")}</dt>
          <dd>{t("about.authorAbilityValue")}</dd>
        </dl>
      </div>

      <h3>{t("about.socialLinksHeading")}</h3>
      <ul className={styles.socialLinks}>
        <li>
          GitHub:{" "}
          <a href="https://github.com/hakatashi" target="_blank" rel="noopener noreferrer">
            https://github.com/hakatashi
          </a>
        </li>
        <li>
          X:{" "}
          <a href="https://x.com/hakatashi" target="_blank" rel="noopener noreferrer">
            https://x.com/hakatashi
          </a>
        </li>
        <li>
          Mastodon:{" "}
          <a href="https://pawoo.net/@hakatashi" target="_blank" rel="noopener noreferrer">
            @hakatashi@pawoo.net
          </a>
        </li>
        <li>
          Email: <a href="mailto:hakatasiloving@gmail.com">hakatasiloving@gmail.com</a>
        </li>
      </ul>

      <h2>{t("about.troubleHeading")}</h2>
      <p>{t("about.troubleText1")}</p>
      <p className={staticStyles.disclaimer}>{t("about.troubleText2")}</p>

      <h2>{t("about.noTroubleHeading")}</h2>
      <p>{t("about.noTroubleText")}</p>
    </section>
  );
}
