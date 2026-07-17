import { ByteReader } from "../byte-reader.js";
import { readBufferedUint32LE } from "../lzss.js";
import { readModernUserdata } from "../userdata.js";
import { emptySplit, normalizeText, resourceCount, type ParsedReplay, type ReplayStageSplit } from "../types.js";
import { REPLAY_GAME_TITLES } from "../game-ids.js";
import { decodeModernBody } from "./modern-body.js";

/** t10r (東方風神録) デコーダ。threplay の Read_t10r を移植。 */
export function parseTh10(original: Uint8Array): ParsedReplay {
  const decodedata = decodeModernBody(
    original,
    { blockSize: 0x400, base: 0xaa, add: 0xe1 },
    { blockSize: 0x80, base: 0x3d, add: 0x7a },
  );

  const splits: ReplayStageSplit[] = [];
  let stageOffset = 0x64;
  const stageCount = Math.min(decodedata[0x4c] ?? 0, 6);
  for (let i = 0; i < stageCount; i++) {
    const split = emptySplit();
    split.stage = decodedata[stageOffset] ?? null;
    split.score = readBufferedUint32LE(decodedata, stageOffset + 0xc) * 10;
    split.power = (0.05 * readBufferedUint32LE(decodedata, stageOffset + 0x10)).toFixed(2);
    split.piv = readBufferedUint32LE(decodedata, stageOffset + 0x14);
    split.lives = resourceCount(decodedata[stageOffset + 0x1c] ?? 0);
    split.graze = 0;
    // threplay の Read_t10r はボム数を抽出しておらず常に "0" を返していた。
    // 実データではないため、このパッケージでは取得不能として null を返す。
    split.bombs = null;
    splits.push(split);
    stageOffset += readBufferedUint32LE(decodedata, stageOffset + 0x8) + 0x1c4;
  }

  const reader = new ByteReader(original);
  const userdata = readModernUserdata(reader);

  return {
    game: "th10",
    gameTitle: REPLAY_GAME_TITLES.th10,
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
