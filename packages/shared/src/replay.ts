import type { ParsedReplay } from "@sattori/touhou-replay-parser";
import type { GameId } from "./games.js";

/**
 * リプレイファイル（.rpy）を解析して得られるプレイ内容の要約。
 * packages/replay-parser の `ParsedReplay` から Sattori のページA表示・録画メタデータに
 * 必要な項目だけを抜き出したサブセット（`fromParsedReplay` で変換する）。
 */
export interface ReplayInfo {
  /** 判定されたタイトル。 */
  game: GameId;
  /** プレイヤー名（リプレイに記録された表示名）。取得できなければ空文字列。 */
  player: string;
  /** 記録日時（元データの表記をそのまま保持）。 */
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

/**
 * `@sattori/touhou-replay-parser` の `ParsedReplay`（ステージ内訳など Sattori では
 * 使わない情報も含むリッチな型）を `ReplayInfo` に変換する。
 * replay-parser は単体でOSS公開できるよう Sattori 固有の型に依存しない設計に
 * なっているため、変換はこの Sattori 側（shared）で行う。
 */
export function fromParsedReplay(parsed: ParsedReplay): ReplayInfo {
  return {
    game: parsed.game,
    player: parsed.player ?? "",
    date: parsed.date,
    character: parsed.character,
    difficulty: parsed.difficulty,
    stage: parsed.stage,
    score: parsed.score,
    cleared: parsed.cleared,
  };
}
