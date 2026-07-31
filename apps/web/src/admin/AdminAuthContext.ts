import { createContext, useContext } from "react";

export interface AdminAuthValue {
  /** ログイン済みトークン。`AdminApp`が未ログイン時はこのContextごと配下を描画しないため常に非null。 */
  token: string;
  /** 401/403を受けた画面がログイン画面へ戻るために呼ぶ。 */
  onUnauthorized: () => void;
}

export const AdminAuthContext = createContext<AdminAuthValue | null>(null);

/** `AdminAuthContext.Provider`配下でのみ呼べる。Provider外で呼ぶのは実装ミスのため例外にする。 */
export function useAdminAuth(): AdminAuthValue {
  const value = useContext(AdminAuthContext);
  if (!value) {
    throw new Error("useAdminAuth は AdminAuthContext.Provider の配下でのみ使用できます");
  }
  return value;
}
