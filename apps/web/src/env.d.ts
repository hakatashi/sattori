/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** API のベースURL。未設定時は同一オリジンの /api を使う（開発時は Vite proxy）。 */
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
