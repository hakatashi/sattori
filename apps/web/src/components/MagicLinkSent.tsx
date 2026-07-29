import { Trans, useTranslation } from "react-i18next";
import styles from "./MagicLinkSent.module.css";

interface Props {
  email: string;
}

/**
 * 「次のステップ」押下後、マジックリンクメールの送信要求が成功した際に表示する画面。
 * メール内のリンクをクリックすると録画が開始する（ページBの作り込みはIssue #10）。
 */
export function MagicLinkSent({ email }: Props) {
  const { t } = useTranslation();

  return (
    <section className={styles.card}>
      <h1 className={styles.heading}>{t("magicLinkSent.heading")}</h1>
      <p>
        <Trans i18nKey="magicLinkSent.sentTo" values={{ email }} components={[<strong key="email" />]} />
      </p>
      <p className={styles.hint}>{t("magicLinkSent.hint")}</p>
    </section>
  );
}
