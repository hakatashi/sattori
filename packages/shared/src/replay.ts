import type { GameId } from "./games.js";

/**
 * リプレイファイル（.rpy）を解析して得られるプレイ内容の要約。
 * packages/replay-parser がこの型を出力し、ページAのプレビュー・録画メタデータに使う。
 * フェーズ1では未使用（フェーズ2でパーサーを実装して組み込む）。
 */
export interface ReplayInfo {
  /** 判定されたタイトル。 */
  game: GameId;
  /** プレイヤー名（リプレイに記録された表示名）。 */
  player: string;
  /** 記録日時（ISO 8601文字列に正規化。元データが曖昧な場合は生文字列）。 */
  date: string | null;
  /** 使用キャラ／機体（例: "霊夢A"）。判定できなければ null。 */
  character: string | null;
  /** 難易度（例: "Hard", "Lunatic"）。 */
  difficulty: string | null;
  /** 到達／記録ステージ（例: "Stage 6", "All"）。 */
  stage: string | null;
  /** スコア。 */
  score: number | null;
  /** クリア（全面クリア）記録かどうか。判定できなければ null。 */
  cleared: boolean | null;
}
