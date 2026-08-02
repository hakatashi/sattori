import { useEffect } from "react";
import type { ReactNode } from "react";
import { Link, NavLink } from "react-router-dom";
import styles from "./AdminLayout.module.css";

interface Props {
  children: ReactNode;
  onLogout: () => void;
}

/**
 * 管理画面(`/admin`)専用のシェル。ユーザー向けページ(`../App.tsx`の`Layout`)とは
 * 意図的に共有しない: `LanguageSwitcher`が存在しない`/en/admin`へのリンクを出してしまう
 * ことや、ユーザー向けの`main`幅(50rem)がジョブ一覧テーブルには狭すぎることが理由
 * （Issue #51）。
 */
export function AdminLayout({ children, onLogout }: Props) {
  useEffect(() => {
    document.title = "Sattori 管理画面";
  }, []);

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <p className={styles.title}>
          <Link to="/admin">Sattori 管理画面</Link>
        </p>
        <nav className={styles.nav}>
          {/* `end`はジョブ一覧(index)だけに付ける。付けないと詳細ページでも
              一覧が現在地扱いになる。 */}
          <NavLink
            to="/admin"
            end
            className={({ isActive }) => (isActive ? styles.navLinkActive : styles.navLink)}
          >
            ジョブ
          </NavLink>
          <NavLink
            to="/admin/costs"
            className={({ isActive }) => (isActive ? styles.navLinkActive : styles.navLink)}
          >
            コスト
          </NavLink>
        </nav>
        <button className={styles.logout} type="button" onClick={onLogout}>
          ログアウト
        </button>
      </header>
      <main className={styles.main}>{children}</main>
    </div>
  );
}
