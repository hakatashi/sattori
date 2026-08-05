import { useTranslation } from "react-i18next";
import staticStyles from "./StaticPage.module.css";

interface Section {
  heading: string;
  paragraphs: string[];
  list?: string[];
  closing?: string[];
}

/** 利用規約ページ（`/terms`）。フッターからナビゲーションする。 */
export function TermsPage() {
  const { t } = useTranslation();
  const intro = t("terms.intro", { returnObjects: true }) as string[];
  const sections = t("terms.sections", { returnObjects: true }) as Section[];

  return (
    <section className={staticStyles.card}>
      <h1 className={staticStyles.heading}>{t("terms.heading")}</h1>
      <p className={staticStyles.disclaimer}>{t("terms.updatedAt")}</p>
      {intro.map((paragraph) => (
        <p key={paragraph}>{paragraph}</p>
      ))}
      {sections.map((section) => (
        <div key={section.heading}>
          <h2>{section.heading}</h2>
          {section.paragraphs.map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
          ))}
          {section.list && (
            <ul>
              {section.list.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          )}
          {section.closing?.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
        </div>
      ))}
    </section>
  );
}
