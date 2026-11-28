import type { GameId } from "./games.js";

/**
 * th06nc（東方紅魔郷: New Classic）の表示言語（Issue #378）。
 *
 * th06ncはシリーズ初の公式多言語対応タイトルで、スペルカード名・会話・一部UIが言語ごとに
 * 切り替わる。ゲーム内に言語選択UIは無く、**実Steamのライブラリ設定が返す言語名**
 * （`ISteamApps::GetCurrentGameLanguage()`）で決まる。録画ワーカーはSteamworks APIスタブ
 * （`worker/mods/tools/steam_stub.cpp`）がこの値を返すので、ここの値はSteamの言語名そのもの
 * （`worker/record_th06nc.py`の`_LANGUAGES`と一致させること）。
 *
 * これは録画品質の設定ではなく、動画に映る文字の言語を選ぶ設定である。リプレイファイルは
 * 言語に依存しないので、どの言語で録ってもリプレイの内容（ずれ）には影響しない。
 */
export const TH06NC_LANGUAGES = [
  "japanese",
  "english",
  "schinese",
  "tchinese",
  "koreana",
  "french",
  "german",
  "spanish",
  "latam",
  "russian",
  "brazilian",
  "italian",
] as const;

export type Th06ncLanguage = (typeof TH06NC_LANGUAGES)[number];

/** 既定の言語。このオプションの導入前に作られたジョブも日本語で録画されている。 */
export const DEFAULT_TH06NC_LANGUAGE: Th06ncLanguage = "japanese";

/** 言語選択UIに出す名称（各言語の自称。UIの表示言語によらず固定）。公式サイトの並び順。 */
export const TH06NC_LANGUAGE_LABELS: Record<Th06ncLanguage, string> = {
  japanese: "日本語",
  english: "English",
  schinese: "简体中文",
  tchinese: "繁體中文",
  koreana: "한국어",
  spanish: "Español (España)",
  latam: "Español (Latinoamérica)",
  french: "Français",
  german: "Deutsch",
  russian: "Русский",
  brazilian: "Português (Brasil)",
  italian: "Italiano",
};

/** 言語選択が意味を持つ唯一のタイトル（他タイトルは言語を切り替えられない）。 */
export const TH06NC_LANGUAGE_GAME_ID: GameId = "th06nc";

export function isTh06ncLanguage(value: unknown): value is Th06ncLanguage {
  return typeof value === "string" && (TH06NC_LANGUAGES as readonly string[]).includes(value);
}

/** このタイトルで言語を選べるか。解析前（null）は false。 */
export function supportsTh06ncLanguage(game: GameId | null): boolean {
  return game === TH06NC_LANGUAGE_GAME_ID;
}

/**
 * `RecordingOptions.th06ncLanguage`を読む。無い・不正値は日本語。
 * オプション導入前のジョブにはフィールドが無いので、読むときは必ずこれを通すこと。
 */
export function th06ncLanguageOf(options: { th06ncLanguage?: unknown }): Th06ncLanguage {
  return isTh06ncLanguage(options.th06ncLanguage) ? options.th06ncLanguage : DEFAULT_TH06NC_LANGUAGE;
}
