import { ByteReader } from "../byte-reader.js";
import { localizeCharacterName } from "../character-names.js";
import { jumpToUser, parseIntStrict } from "../userdata.js";
import { DATE_TOKENS_YMD_HM, parseDateComponents } from "../date-format.js";
import { normalizeText, type ParsedReplay } from "../types.js";
import { REPLAY_GAME_TITLES } from "../game-ids.js";

/**
 * t125 (ダブルスポイラー ～ 東方文花帖, DS) decoder. Ported from Read_t125 in threplay.
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
  const characterName = normalizeText(character);
  const { ja: characterNameJa, en: characterNameEn } = localizeCharacterName("th125", characterName);

  return {
    game: "th125",
    gameTitle: REPLAY_GAME_TITLES.th125,
    formatVersion: null,
    player: normalizeText(name),
    date: normalizeText(date),
    parsedDate: parseDateComponents(normalizeText(date), DATE_TOKENS_YMD_HM),
    recordedAt: null,
    character: characterName,
    characterNameJa,
    characterNameEn,
    difficulty: null,
    stage: normalizeText(stage),
    score,
    cleared: null,
    loadout: null,
    splits: [],
    frameCount: null,
  };
}
