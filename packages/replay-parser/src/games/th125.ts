import { ByteReader } from "../byte-reader.js";
import { jumpToUser, parseIntStrict } from "../userdata.js";
import { normalizeText, type ParsedReplay } from "../types.js";
import { REPLAY_GAME_TITLES } from "../game-ids.js";

/**
 * t125 (ダブルスポイラー ～ 東方文花帖) デコーダ。threplay の Read_t125 を移植。
 */
export function parseTh125(original: Uint8Array): ParsedReplay {
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
  reader.skip(6);
  const character = reader.readAnsiString();
  const stage = reader.readAnsiString();
  reader.skip(6);
  const score = parseIntStrict(reader.readAnsiString());

  return {
    game: "th125",
    gameTitle: REPLAY_GAME_TITLES.th125,
    formatVersion: null,
    player: normalizeText(name),
    date: normalizeText(date),
    character: normalizeText(character),
    difficulty: null,
    stage: normalizeText(stage),
    score,
    cleared: null,
    splits: [],
  };
}
