import type { GameId } from "@sattori/shared";

/**
 * アップロード画面で録画速度（Issue #288、倍速録画）を選べるタイトル。
 *
 * バックエンド（`POST /magic-links`）は全タイトルで録画速度を受け付けるが、UIに出す
 * タイトルは本番での動作確認を経ながら段階的に広げる（ユーザー判断）:
 *
 *   1. th15（利用の少ないタイトルで2倍速の実運用を確認する）
 *   2. th07（おすすめが3倍速の唯一のタイトルで3倍速の実運用を確認する）
 *   3. 残り全タイトル（同時に低速録画を廃止する）
 *
 * ここに無いタイトルは選択肢を出さず、従来どおり等倍で録画する。
 */
export const RECORDING_SPEED_SELECTABLE_GAME_IDS: readonly GameId[] = ["th15"];

export function isRecordingSpeedSelectable(game: GameId | null): boolean {
  return game !== null && RECORDING_SPEED_SELECTABLE_GAME_IDS.includes(game);
}
