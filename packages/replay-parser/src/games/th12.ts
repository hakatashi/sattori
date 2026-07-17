import { ByteReader } from "../byte-reader.js";
import { readBufferedUint32LE } from "../lzss.js";
import { readModernUserdata } from "../userdata.js";
import { emptySplit, normalizeText, resourceCount, type ParsedReplay, type ReplayStageSplit } from "../types.js";
import { REPLAY_GAME_TITLES } from "../game-ids.js";
import { decodeModernBody } from "./modern-body.js";

const UFO_COLORS = ["None", "Red", "Blue", "Green"];

/** t12r (東方星蓮船) デコーダ。threplay の Read_t12r を移植。 */
export function parseTh12(original: Uint8Array): ParsedReplay {
  const decodedata = decodeModernBody(
    original,
    { blockSize: 0x800, base: 0x5e, add: 0xe1 },
    { blockSize: 0x40, base: 0x7d, add: 0x3a },
  );

  const splits: ReplayStageSplit[] = [];
  let stageOffset = 0x70;
  const stageCount = Math.min(decodedata[0x58] ?? 0, 6);
  for (let i = 0; i < stageCount; i++) {
    const split = emptySplit();
    split.stage = decodedata[stageOffset] ?? null;
    split.score = readBufferedUint32LE(decodedata, stageOffset + 0xc) * 10;
    split.power = (readBufferedUint32LE(decodedata, stageOffset + 0x10) / 100).toFixed(2);
    split.piv = Math.trunc(readBufferedUint32LE(decodedata, stageOffset + 0x14) / 1000) * 10;

    const lives = decodedata[stageOffset + 0x18] ?? 0;
    let livePieces = decodedata[stageOffset + 0x1a] ?? 0;
    if (livePieces > 0) livePieces -= 1;
    const bombs = decodedata[stageOffset + 0x1c] ?? 0;
    const bombPieces = decodedata[stageOffset + 0x1e] ?? 0;

    const ufos: string[] = [];
    for (let j = 0; j < 3; j++) {
      const colorIndex = decodedata[stageOffset + 0x20 + j * 4] ?? 0;
      ufos.push(UFO_COLORS[colorIndex] ?? "None");
    }
    split.additional = { ufoColors: ufos };
    split.lives = resourceCount(lives, livePieces, 4);
    split.bombs = resourceCount(bombs, bombPieces, 3);
    split.graze = readBufferedUint32LE(decodedata, stageOffset + 0x44);
    splits.push(split);
    stageOffset += readBufferedUint32LE(decodedata, stageOffset + 0x8) + 0xa0;
  }

  const userdata = readModernUserdata(new ByteReader(original));

  return {
    game: "th12",
    gameTitle: REPLAY_GAME_TITLES.th12,
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
