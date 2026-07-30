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
  window.localStorage.setItem(STORAGE_KEY, token);
}

export function clearAdminToken(): void {
  window.localStorage.removeItem(STORAGE_KEY);
}
