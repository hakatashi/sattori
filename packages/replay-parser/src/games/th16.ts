import { ByteReader } from "../byte-reader.js";
import { readBufferedUint32LE } from "../lzss.js";
import { readModernUserdata } from "../userdata.js";
import { emptySplit, normalizeText, resourceCount, type ParsedReplay, type ReplayStageSplit } from "../types.js";
import { REPLAY_GAME_TITLES } from "../game-ids.js";
import { decodeModernBody } from "./modern-body.js";

/** t16r (東方天空璋, HSiFS) decoder. Ported from Read_t16r in threplay. */
export function parseTh16(original: Uint8Array): ParsedReplay {
  const decodedata = decodeModernBody(
    original,
    { blockSize: 0x400, base: 0x5c, add: 0xe1 },
    { blockSize: 0x100, base: 0x7d, add: 0x3a },
  );

  const splits: ReplayStageSplit[] = [];
  let stageOffset = 0xa0;
  const stageCount = Math.min(decodedata[0x80] ?? 0, 6);
  for (let i = 0; i < stageCount; i++) {
    const split = emptySplit();
    split.stage = decodedata[stageOffset] ?? null;
    split.score = readBufferedUint32LE(decodedata, stageOffset + 0x34) * 10;
    split.power = (readBufferedUint32LE(decodedata, stageOffset + 0x68) / 100).toFixed(2);
    split.piv = Math.trunc(readBufferedUint32LE(decodedata, stageOffset + 0x5c) / 1000) * 10;
    const lives = decodedata[stageOffset + 0x78] ?? 0;
    const bombs = decodedata[stageOffset + 0x84] ?? 0;
    const bombPieces = decodedata[stageOffset + 0x88] ?? 0;
    const season = readBufferedUint32LE(decodedata, stageOffset + 0x8c);
    const seasonMax = readBufferedUint32LE(decodedata, stageOffset + 0x90);
    split.additional = { season, seasonMax };
    split.lives = resourceCount(lives);
    split.graze = readBufferedUint32LE(decodedata, stageOffset + 0x44);
    split.bombs = resourceCount(bombs, bombPieces, 5);
    splits.push(split);
    stageOffset += readBufferedUint32LE(decodedata, stageOffset + 0x8) + 0x294;
  }

  const userdata = readModernUserdata(new ByteReader(original));

  return {
    game: "th16",
    gameTitle: REPLAY_GAME_TITLES.th16,
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
