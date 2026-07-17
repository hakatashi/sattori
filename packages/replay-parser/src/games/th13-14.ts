import { ByteReader } from "../byte-reader.js";
import { readBufferedUint32LE } from "../lzss.js";
import { jumpToUser, parseScoreWithTrailingZero } from "../userdata.js";
import { emptySplit, normalizeText, resourceCount, type ParsedReplay, type ReplayStageSplit } from "../types.js";
import { REPLAY_GAME_TITLES } from "../game-ids.js";
import { decodeModernBody } from "./modern-body.js";

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
  const decodedata = decodeModernBody(
    original,
    { blockSize: 0x400, base: 0x5c, add: 0xe1 },
    { blockSize: 0x100, base: 0x7d, add: 0x3a },
  );

  if (isTd) {
    let stageOffset = 0x74;
    const stageCount = Math.min(decodedata[0x58] ?? 0, 6);
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
      splits.push(split);
      stageOffset += readBufferedUint32LE(decodedata, stageOffset + 0x8) + 0xc4;
    }
  } else {
    let stageOffset = 0x94;
    const stageCount = Math.min(decodedata[0x78] ?? 0, 6);
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
      splits.push(split);
      stageOffset += readBufferedUint32LE(decodedata, stageOffset + 0x8) + 0xdc;
    }
  }

  const game = isTd ? "th13" : "th14";
  return {
    game,
    gameTitle: REPLAY_GAME_TITLES[game],
    formatVersion: versionByte,
    player: normalizeText(name),
    date: normalizeText(date),
    character: normalizeText(character),
    difficulty: normalizeText(difficulty),
    stage: normalizeText(stage),
    score,
    cleared: stage.includes("Clear"),
    splits,
  };
}
