import { ByteReader } from "../byte-reader.js";
import { readBufferedUint32LE } from "../lzss.js";
import { readModernUserdata } from "../userdata.js";
import { emptySplit, normalizeText, resourceCount, type ParsedReplay, type ReplayStageSplit } from "../types.js";
import { REPLAY_GAME_TITLES } from "../game-ids.js";
import { decodeModernBody } from "./modern-body.js";

/** t18r (東方虹龍洞, UM) decoder. Ported from Read_t18r in threplay. */
export function parseTh18(original: Uint8Array): ParsedReplay {
  const decodedata = decodeModernBody(
    original,
    { blockSize: 0x400, base: 0x5c, add: 0xe1 },
    { blockSize: 0x100, base: 0x7d, add: 0x3a },
  );

  const splits: ReplayStageSplit[] = [];
  let stageOffset = 0xc8;
  const stageCount = Math.min(decodedata[0xa8] ?? 0, 6);
  for (let i = 0; i < stageCount; i++) {
    const split = emptySplit();
    split.stage = decodedata[stageOffset] ?? null;
    split.score = readBufferedUint32LE(decodedata, stageOffset + 0x88) * 10;
    split.power = (readBufferedUint32LE(decodedata, stageOffset + 0xc4) / 100).toFixed(2);
    split.piv = readBufferedUint32LE(decodedata, stageOffset + 0xbc);
    const lives = decodedata[stageOffset + 0xd4] ?? 0;
    const livePieces = decodedata[stageOffset + 0xd8] ?? 0;
    const bombs = decodedata[stageOffset + 0xe4] ?? 0;
    const bombPieces = decodedata[stageOffset + 0xe8] ?? 0;

    const cards: number[] = [];
    for (let cardByteOffset = 0x160; cardByteOffset < 1376; cardByteOffset += 4) {
      const cardId = readBufferedUint32LE(decodedata, stageOffset + cardByteOffset);
      if (cardId === 0xffffffff) break;
      cards.push(cardId);
    }
    const active = readBufferedUint32LE(decodedata, stageOffset + 2400);
    split.additional = { cards, active };
    split.lives = resourceCount(lives, livePieces, 3);
    split.graze = 0;
    split.bombs = resourceCount(bombs, bombPieces, 3);
    splits.push(split);
    stageOffset += readBufferedUint32LE(decodedata, stageOffset + 0x8) + 0x126c;
  }

  const userdata = readModernUserdata(new ByteReader(original));

  return {
    game: "th18",
    gameTitle: REPLAY_GAME_TITLES.th18,
    formatVersion: null,
    player: normalizeText(userdata.name),
    date: normalizeText(userdata.date),
    character: normalizeText(userdata.character),
    difficulty: normalizeText(userdata.difficulty),
    stage: normalizeText(userdata.stage),
    score: userdata.score,
    cleared: userdata.stage.includes("Clear"),
    splits,
  };
}
