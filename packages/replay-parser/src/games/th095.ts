import { ByteReader } from "../byte-reader.js";
import { jumpToUser, parseIntStrict } from "../userdata.js";
import { normalizeText, type ParsedReplay } from "../types.js";
import { REPLAY_GAME_TITLES } from "../game-ids.js";

/**
 * t95r (東方文花帖, StB) decoder. Ported from Read_t95r in threplay.
 * Has no LZSS body compression; everything is contained in the USER section.
 */
export function parseTh095(original: Uint8Array): ParsedReplay {
  const reader = new ByteReader(original);
  jumpToUser(reader, 12);

  reader.readUint32LE();
  reader.skip(4);
  reader.readAnsiString();
  reader.readAnsiString();
  reader.skip(5);
  const name = reader.readAnsiString();
  const stagePart1 = reader.readAnsiString();
  const stagePart2 = reader.readAnsiString();
  reader.skip(5);
  const date = reader.readAnsiString();
  reader.skip(6);
  const score = parseIntStrict(reader.readAnsiString());

  return {
    game: "th095",
    gameTitle: REPLAY_GAME_TITLES.th095,
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
