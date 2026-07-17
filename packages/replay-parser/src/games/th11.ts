import { ByteReader } from "../byte-reader.js";
import { readBufferedUint32LE } from "../lzss.js";
import { readModernUserdata } from "../userdata.js";
import { emptySplit, normalizeText, type ParsedReplay, type ReplayStageSplit } from "../types.js";
import { REPLAY_GAME_TITLES } from "../game-ids.js";
import { decodeModernBody } from "./modern-body.js";

/** t11r (東方地霊殿) デコーダ。threplay の Read_t11r を移植。 */
export function parseTh11(original: Uint8Array): ParsedReplay {
  const decodedata = decodeModernBody(
    original,
    { blockSize: 0x800, base: 0xaa, add: 0xe1 },
    { blockSize: 0x40, base: 0x3d, add: 0x7a },
  );

  const splits: ReplayStageSplit[] = [];
  let stageOffset = 0x70;
  const stageCount = Math.min(decodedata[0x58] ?? 0, 6);
  for (let i = 0; i < stageCount; i++) {
    const split = emptySplit();
    split.stage = decodedata[stageOffset] ?? null;
    split.score = readBufferedUint32LE(decodedata, stageOffset + 0xc) * 10;
    split.power = (0.05 * readBufferedUint32LE(decodedata, stageOffset + 0x10)).toFixed(2);
    split.piv = readBufferedUint32LE(decodedata, stageOffset + 0x14);
    const lives = decodedata[stageOffset + 0x18] ?? 0;
    const pieces = decodedata[stageOffset + 0x1a] ?? 0;
    split.lives = `${lives} (${pieces}/5)`;
    split.graze = readBufferedUint32LE(decodedata, stageOffset + 0x34);
    split.bombs = "0";
    splits.push(split);
    stageOffset += readBufferedUint32LE(decodedata, stageOffset + 0x8) + 0x90;
  }

  const userdata = readModernUserdata(new ByteReader(original));

  return {
    game: "th11",
    gameTitle: REPLAY_GAME_TITLES.th11,
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
