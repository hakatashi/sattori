import { useState } from "react";
import styles from "./AdminLogin.module.css";

interface Props {
  onLogin: (token: string) => void;
  /** 直前のAPI呼び出しがトークン無効(401/403)で拒否された場合に表示する注記。 */
  invalidTokenNotice: boolean;
}

/**
 * 管理画面(`/admin`、Issue #51)のトークン入力フォーム。ユーザーは管理者1人固定のため、
 * SSM Parameter Store(`/sattori/admin/token`)の値をそのまま貼り付ける運用にしている
 * （手順は`CLAUDE.local.md`参照）。
 */
export function AdminLogin({ onLogin, invalidTokenNotice }: Props) {
  const [value, setValue] = useState("");

  return (
    <form
      className={styles.card}
      onSubmit={(event) => {
        event.preventDefault();
        const trimmed = value.trim();
        if (trimmed) {
          onLogin(trimmed);
        }
      }}
    >
      <h1 className={styles.heading}>Sattori 管理画面</h1>
      <p className={styles.hint}>
        SSM Parameter Store（<code>/sattori/admin/token</code>）に登録されているトークンを入力してください。
      </p>
      {invalidTokenNotice && (
        <p className={styles.error}>トークンが無効です。再入力してください。</p>
      )}
      <input
        className={styles.input}
        type="password"
        autoComplete="off"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder="トークン"
      />
      <button className={styles.submit} type="submit">
        ログイン
      </button>
    </form>
  );
}
