/**
 * フロントエンド（apps/web）が対応する表示言語。バックエンド（apps/api）は
 * マジックリンク要求時に選択言語を受け取り、メール文面・ジョブページリンクの
 * 言語出し分けに使う（`RequestMagicLinkRequest.language` / `JobRecord.language`）。
 */
export const SUPPORTED_LANGUAGES = ["ja", "en"] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];
export const DEFAULT_LANGUAGE: SupportedLanguage = "ja";

export function isSupportedLanguage(value: unknown): value is SupportedLanguage {
  return SUPPORTED_LANGUAGES.includes(value as SupportedLanguage);
}
