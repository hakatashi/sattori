import { Trans, useTranslation } from "react-i18next";
import styles from "./MagicLinkSent.module.css";

interface Props {
  email: string;
  /** 「アップロード画面に戻る」押下時に呼ぶ。ファイル選択・解析結果は保持したまま入力フォームへ戻す。 */
  onBack: () => void;
}

/**
 * 「次のステップ」押下後、マジックリンクメールの送信要求が成功した際に表示する画面。
 * メール内のリンクをクリックすると録画が開始する（ページBの作り込みはIssue #10）。
 */
export function MagicLinkSent({ email, onBack }: Props) {
  const { t } = useTranslation();

  return (
    <section className={styles.card}>
      <h1 className={styles.heading}>{t("magicLinkSent.heading")}</h1>
      <p>
        <Trans i18nKey="magicLinkSent.sentTo" values={{ email }} components={[<strong key="email" />]} />
      </p>
      <p className={styles.hint}>{t("magicLinkSent.hint")}</p>
      <p className={styles.hint}>{t("magicLinkSent.spamHint")}</p>
      <div className={styles.actions}>
        <button type="button" className={styles.back} onClick={onBack}>
          {t("magicLinkSent.back")}
        </button>
      </div>
    </section>
  );
}
