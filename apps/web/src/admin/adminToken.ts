const STORAGE_KEY = "sattori.adminToken";

/**
 * 管理画面(`/admin`、Issue #51)のトークンをlocalStorageで保持する。
 * 管理者は1人固定のため、Cookieやセッション管理は使わずシンプルな共有トークン方式。
 */
export function loadAdminToken(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    // プライベートブラウジング等でlocalStorageが使えない場合は未ログイン扱い。
    return null;
  }
}

export function saveAdminToken(token: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, token);
  } catch {
    // 書き込めない場合（プライベートブラウジング・容量超過）でもログイン自体は
    // 継続できるべきなので握り潰す。次のリロードで再ログインが必要になるだけ。
    // ここでthrowするとログインフォームのsubmitハンドラ内で例外になり、
    // /admin配下にエラーバウンダリが無いため画面が白くなる。
  }
}

export function clearAdminToken(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // 同上（ログアウト操作を例外で失敗させない）。
  }
}
