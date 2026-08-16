import type { TFunction } from "i18next";
import { GAME_TITLES, type GameId } from "@sattori/shared";

/**
 * `SattoriApiError.code` / `ReplayParseFailure.code`（バックエンドAPIのエラー、
 * apps/web/README.md §6「APIのエラーは日本語固定」）を`errors.<code>`キーへ翻訳する。
 * バックエンドは常にAPIのエラーメッセージを日本語で返すため、翻訳が用意されていない
 * 未知のコード（追加漏れ）はその日本語の`fallbackMessage`へフォールバックする（Issue #138）。
 */
export function translateApiErrorMessage(
  t: TFunction,
  code: string,
  fallbackMessage: string,
  params?: Record<string, unknown>,
): string {
  return t(`errors.${code}`, { ...params, defaultValue: fallbackMessage });
}

/**
 * `unsupported_game`はタイトル名を埋め込んだ文言を組み立てる必要があるため専用に扱う。
 * `GAME_TITLES[game].fullName`は日英併記の正式名（`ReplayPreview.tsx`・`GameInfoPage.tsx`と
 * 同じ表記）で、ロケールを問わずそのまま使う。`game`が判明しない場合
 * （`POST /magic-links`がサーバー側の再パースで検出できなかった場合。実際にはページA側の
 * プレビューが先に成功していないとここへは到達しないため理論上の分岐）は、バックエンドの
 * 日本語固定文言（`fallbackMessage`）のまま表示する。
 */
export function translateUnsupportedGameMessage(
  t: TFunction,
  game: GameId | null,
  fallbackMessage: string,
): string {
  if (!game) {
    return fallbackMessage;
  }
  return t("errors.unsupported_game", { title: GAME_TITLES[game].fullName });
}
