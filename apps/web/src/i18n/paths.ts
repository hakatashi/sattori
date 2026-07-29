import type { SupportedLanguage } from "./i18n.ts";

const EN_PREFIX = "/en";

/** pathnameから"/en"プレフィックスを取り除いた、ja基準のパスを返す。 */
function stripLocale(pathname: string): string {
  if (pathname === EN_PREFIX || pathname.startsWith(`${EN_PREFIX}/`)) {
    const rest = pathname.slice(EN_PREFIX.length);
    return rest === "" ? "/" : rest;
  }
  return pathname;
}

/**
 * 現在のpathnameを保ったまま指定言語のパスへ変換する（ヘッダーロゴ・言語切り替え用）。
 * 既定言語(ja)はプレフィックス無し、英語のみ"/en"を付ける
 * （バックエンドが生成するマジックリンクは`/jobs/{jobId}`固定のため）。
 */
export function toLocalizedPath(pathname: string, lang: SupportedLanguage): string {
  const base = stripLocale(pathname);
  if (lang === "ja") {
    return base;
  }
  return base === "/" ? EN_PREFIX : `${EN_PREFIX}${base}`;
}
