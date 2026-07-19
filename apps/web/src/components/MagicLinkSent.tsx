import styles from "./MagicLinkSent.module.css";

interface Props {
  email: string;
  onReset: () => void;
}

/**
 * 「次のステップ」押下後、マジックリンクメールの送信要求が成功した際に表示する画面。
 * メール内のリンクをクリックすると録画が開始する（ページBの作り込みはIssue #10）。
 */
export function MagicLinkSent({ email, onReset }: Props) {
  return (
    <section className={styles.card}>
      <h1 className={styles.heading}>メールを確認してください</h1>
      <p>
        <strong>{email}</strong> 宛に、録画を開始するためのリンクを送信しました。
      </p>
      <p className={styles.hint}>
        メール内のリンクをクリックすると録画が始まります（リンクの有効期限は24時間・1回のみ使用できます）。
      </p>
      <button type="button" className={styles.reset} onClick={onReset}>
        別のリプレイを録画する
      </button>
    </section>
  );
}
