import { ByteReader } from "../byte-reader.js";
import { localizeCharacterName } from "../character-names.js";
import th13SpellCardsData from "../data/th13/spellcards.json" with { type: "json" };
import { readBufferedUint32LE } from "../lzss.js";
import { jumpToUser, parseScoreWithTrailingZero } from "../userdata.js";
import { emptySplit, normalizeText, resourceCount, type ParsedReplay, type ReplayStageSplit } from "../types.js";
import { REPLAY_GAME_TITLES } from "../game-ids.js";
import { DATE_TOKENS_YMD_HM, parseDateComponents } from "../date-format.js";
import { decodeModernBody, RECORDED_AT_OFFSET_12BYTE_NAME } from "./modern-body.js";

/**
 * Offset (within the decompressed body header) of the zero-based spell card
 * index of a spell practice replay; `0xffffffff` for every other kind of
 * replay. Like th20, the USER section only says `Stage N` (the stage the card
 * belongs to), so this number is the only thing distinguishing a spell
 * practice replay from a stage practice one. Adding one gives the "No." the
 * in-game Spell Practice menu shows (confirmed against 7 real replays: th13
 * No. 45/62/82, th14 No. 66/98). th14's header is 0x20 bytes longer, which
 * shifts the field accordingly.
 */
const TH13_SPELL_CARD_OFFSET = 0x70;
const TH14_SPELL_CARD_OFFSET = 0x90;
const NOT_SPELL_PRACTICE = 0xffffffff;

/**
 * th13 Spell Practice card number → difficulty/name, transcribed from the
 * game's own Player Data / Spell Select screens (the names are not stored as
 * plain or singly-XORed text in `th13.exe` or the ECL files, so there was no
 * way to extract them from the game assets). The number is difficulty-scoped
 * like th06nc's: one card has one number per difficulty it exists at (No. 1-4
 * 符牒「死蝶の舞」 Easy–Lunatic, and some cards are renamed on Hard/Lunatic).
 * No. 107-119 are Extra and No. 120-127 are the Spell Practice–only
 * "Overdrive" cards, whose replays record the difficulty as `O.D.`.
 */
interface Th13SpellCard {
  number: number;
  difficulty: string;
  name: string;
}
const TH13_SPELL_CARDS_BY_NUMBER = new Map<number, Th13SpellCard>(
  (th13SpellCardsData as Th13SpellCard[]).map((card) => [card.number, card]),
);

/**
 * The t13r magic is shared by th13 (東方神霊廟, TD) and th14 (東方輝針城, DDC),
 * and is distinguished by the version byte in the USER section (144 means TD,
 * anything else means DDC) (ported from Read_t13r in threplay; the
 * distinguishing logic follows the in-code comments).
 *
 * Note: threplay's Read_t13r calls `return Read_Userdata(ref replay)` at the
 * end of the function, re-reading the USER section from a common layout that
 * does not account for the bytes already consumed for TD/DDC detection (a
 * 4-byte "which game" marker + a 1-byte version), causing name/date/character
 * etc. to be overwritten from the wrong offsets (judged to be an upstream
 * bug). This port instead keeps the result of the first read, which already
 * reflects the TD/DDC detection logic, and does not perform this duplicate read.
 */
export function parseTh1314(original: Uint8Array): ParsedReplay {
  const reader = new ByteReader(original);
  jumpToUser(reader, 12);

  reader.readUint32LE();
  reader.skip(4);
  reader.skip(4); // which-game marker
  const versionByte = reader.readUint8();
  const isTd = versionByte === 144;

  reader.readAnsiString();
  reader.readAnsiString();
  reader.skip(5);
  const name = reader.readAnsiString();
  reader.skip(5);
  const date = reader.readAnsiString();
  reader.skip(6);
  const character = reader.readAnsiString();
  reader.skip(5);
  const difficulty = reader.readAnsiString();
  const stage = reader.readAnsiString();
  reader.skip(6);
  const score = parseScoreWithTrailingZero(reader.readAnsiString());

  const splits: ReplayStageSplit[] = [];
  let frameCount = 0;
  const decodedata = decodeModernBody(
    original,
    { blockSize: 0x400, base: 0x5c, add: 0xe1 },
    { blockSize: 0x100, base: 0x7d, add: 0x3a },
  );

  let stageCount: number;
  if (isTd) {
    let stageOffset = 0x74;
    stageCount = Math.min(decodedata[0x58] ?? 0, 6);
    for (let i = 0; i < stageCount; i++) {
      const split = emptySplit();
      split.stage = decodedata[stageOffset] ?? null;
      split.score = readBufferedUint32LE(decodedata, stageOffset + 0x1c) * 10;
      split.power = (readBufferedUint32LE(decodedata, stageOffset + 0x44) / 100).toFixed(2);
      split.piv = Math.trunc(readBufferedUint32LE(decodedata, stageOffset + 0x38) / 1000) * 10;
      const lives = decodedata[stageOffset + 0x50] ?? 0;
      const livePieces = decodedata[stageOffset + 0x54] ?? 0;
      const bombs = decodedata[stageOffset + 0x5c] ?? 0;
      const bombPieces = decodedata[stageOffset + 0x60] ?? 0;
      const trance = decodedata[stageOffset + 0x64] ?? 0;
      split.additional = { trance, tranceMax: 600 };
      split.lives = resourceCount(lives, livePieces, null);
      split.graze = readBufferedUint32LE(decodedata, stageOffset + 0x2c);
      split.bombs = resourceCount(bombs, bombPieces, 8);
      const stageFrameCount = readBufferedUint32LE(decodedata, stageOffset + 0x4);
      split.frameCount = stageFrameCount;
      splits.push(split);
      frameCount += stageFrameCount;
      stageOffset += readBufferedUint32LE(decodedata, stageOffset + 0x8) + 0xc4;
    }
  } else {
    let stageOffset = 0x94;
    stageCount = Math.min(decodedata[0x78] ?? 0, 6);
    for (let i = 0; i < stageCount; i++) {
      const split = emptySplit();
      split.stage = decodedata[stageOffset] ?? null;
      split.score = readBufferedUint32LE(decodedata, stageOffset + 0x1c) * 10;
      split.power = (readBufferedUint32LE(decodedata, stageOffset + 0x44) / 100).toFixed(2);
      split.piv = Math.trunc(readBufferedUint32LE(decodedata, stageOffset + 0x38) / 1000) * 10;
      const lives = decodedata[stageOffset + 0x50] ?? 0;
      const livePieces = decodedata[stageOffset + 0x54] ?? 0;
      const bombs = decodedata[stageOffset + 0x5c] ?? 0;
      const bombPieces = decodedata[stageOffset + 0x60] ?? 0;
      split.lives = resourceCount(lives, livePieces, 3);
      split.graze = readBufferedUint32LE(decodedata, stageOffset + 0x2c);
      split.bombs = resourceCount(bombs, bombPieces, 8);
      const stageFrameCount = readBufferedUint32LE(decodedata, stageOffset + 0x4);
      split.frameCount = stageFrameCount;
      splits.push(split);
      frameCount += stageFrameCount;
      stageOffset += readBufferedUint32LE(decodedata, stageOffset + 0x8) + 0xdc;
    }
  }

  const spellCardIndex = readBufferedUint32LE(decodedata, isTd ? TH13_SPELL_CARD_OFFSET : TH14_SPELL_CARD_OFFSET);
  const normalizedStage = normalizeText(stage);
  let normalizedDifficulty = normalizeText(difficulty);
  let stageText = normalizedStage;
  if (spellCardIndex !== NOT_SPELL_PRACTICE) {
    const spellNumber = spellCardIndex + 1;
    // Only th13's table exists; th14 stays number-only.
    const card = isTd ? TH13_SPELL_CARDS_BY_NUMBER.get(spellNumber) : undefined;
    // The USER section abbreviates Overdrive to `O.D.`; the table has the
    // full name (and agrees with the USER section for every other difficulty).
    if (card !== undefined) normalizedDifficulty = card.difficulty;
    const label = card === undefined ? `Spell Practice No. ${spellNumber}` : `Spell Practice No. ${spellNumber} ${card.name}`;
    // th13 follows th06nc (`Spell Practice No. 33 name`, no stage prefix; the
    // stage is already in `splits[0].stage`). th14 keeps the th20-style form.
    stageText = isTd ? label : `${normalizedStage ?? "Stage"} (${label})`;
  }

  const game = isTd ? "th13" : "th14";
  const characterName = normalizeText(character);
  const { ja: characterNameJa, en: characterNameEn } = localizeCharacterName(game, characterName);
  return {
    game,
    gameTitle: REPLAY_GAME_TITLES[game],
    formatVersion: versionByte,
    player: normalizeText(name),
    date: normalizeText(date),
    parsedDate: parseDateComponents(normalizeText(date), DATE_TOKENS_YMD_HM),
    recordedAt: readBufferedUint32LE(decodedata, RECORDED_AT_OFFSET_12BYTE_NAME),
    character: characterName,
    characterNameJa,
    characterNameEn,
    difficulty: normalizedDifficulty,
    stage: stageText,
    score,
    cleared: stage.includes("Clear"),
    loadout: null,
    splits,
    frameCount: stageCount > 0 ? frameCount : null,
  };
}
