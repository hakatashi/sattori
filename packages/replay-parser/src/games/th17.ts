import { ByteReader } from "../byte-reader.js";
import { readBufferedUint32LE } from "../lzss.js";
import { readModernUserdata } from "../userdata.js";
import { emptySplit, normalizeText, resourceCount, type ParsedReplay, type ReplayStageSplit } from "../types.js";
import { REPLAY_GAME_TITLES } from "../game-ids.js";
import { decodeModernBody } from "./modern-body.js";

/** t17r (東方鬼形獣, WBaWC) decoder. Ported from Read_t17r in threplay. */
export function parseTh17(original: Uint8Array): ParsedReplay {
  const decodedata = decodeModernBody(
    original,
    { blockSize: 0x400, base: 0x5c, add: 0xe1 },
    { blockSize: 0x100, base: 0x7d, add: 0x3a },
  );

  const splits: ReplayStageSplit[] = [];
  let stageOffset = 0xa0;
  let frameCount = 0;
  const stageCount = Math.min(decodedata[0x84] ?? 0, 6);
  for (let i = 0; i < stageCount; i++) {
    const split = emptySplit();
    split.stage = decodedata[stageOffset] ?? null;
    split.score = readBufferedUint32LE(decodedata, stageOffset + 0x34) * 10;
    split.power = (readBufferedUint32LE(decodedata, stageOffset + 0x68) / 100).toFixed(2);
    split.piv = Math.trunc(readBufferedUint32LE(decodedata, stageOffset + 0x5c) / 1000) * 10;
    const lives = decodedata[stageOffset + 0x78] ?? 0;
    const livePieces = decodedata[stageOffset + 0x7c] ?? 0;
    const bombs = decodedata[stageOffset + 0x84] ?? 0;
    const bombPieces = decodedata[stageOffset + 0x88] ?? 0;
    split.lives = resourceCount(lives, livePieces, 3);
    split.graze = readBufferedUint32LE(decodedata, stageOffset + 0x44);
    split.bombs = resourceCount(bombs, bombPieces, 3);
    const stageFrameCount = readBufferedUint32LE(decodedata, stageOffset + 0x4);
    split.frameCount = stageFrameCount;
    splits.push(split);
    frameCount += stageFrameCount;
    stageOffset += readBufferedUint32LE(decodedata, stageOffset + 0x8) + 0x158;
  }

  const userdata = readModernUserdata(new ByteReader(original));

  return {
    game: "th17",
    gameTitle: REPLAY_GAME_TITLES.th17,
    formatVersion: null,
    player: normalizeText(userdata.name),
    date: normalizeText(userdata.date),
    character: normalizeText(userdata.character),
    difficulty: normalizeText(userdata.difficulty),
    stage: normalizeText(userdata.stage),
    score: userdata.score,
    cleared: userdata.stage.includes("Clear"),
    splits,
    frameCount: stageCount > 0 ? frameCount : null,
  };
}
