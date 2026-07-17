import { ByteReader } from "../byte-reader.js";
import { jumpToUser, parseScoreWithTrailingZero } from "../userdata.js";
import { normalizeText, type ParsedReplay } from "../types.js";
import { REPLAY_GAME_TITLES, type ReplayGameId } from "../game-ids.js";

/**
 * t143 (弾幕アマノジャク) / t156 (秘封ナイトメアダイアリー) 共通デコーダ。
 * threplay の Read_t143（Read_t156 はこれを呼ぶだけの別名）を移植。
 */
export function parseTh143Family(original: Uint8Array, game: "th143" | "th165"): ParsedReplay {
  const reader = new ByteReader(original);
  jumpToUser(reader, 12);

  reader.readUint32LE();
  reader.skip(4);
  reader.readAnsiString();
  reader.readAnsiString();
  reader.skip(5);
  const name = reader.readAnsiString();
  reader.skip(5);
  const date = reader.readAnsiString();
  const stagePart1 = reader.readAnsiString();
  const stagePart2 = reader.readAnsiString();
  reader.skip(6);
  const score = parseScoreWithTrailingZero(reader.readAnsiString());

  return {
    game,
    gameTitle: REPLAY_GAME_TITLES[game as ReplayGameId],
    formatVersion: null,
    player: normalizeText(name),
    date: normalizeText(date),
    character: null,
    difficulty: null,
    stage: normalizeText(`${stagePart1} ${stagePart2}`),
    score,
    cleared: null,
    splits: [],
  };
}
