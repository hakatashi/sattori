import { ByteReader } from "../byte-reader.js";
import { ReplayCorruptError } from "../errors.js";
import { decompress, readBufferedUint32LE, xorBlockDecode } from "../lzss.js";
import { jumpToUser, parseScoreWithTrailingZero } from "../userdata.js";
import { emptySplit, normalizeText, resourceCount, type ParsedReplay, type ReplayStageSplit } from "../types.js";
import { REPLAY_GAME_TITLES } from "../game-ids.js";

const HEADER_SIZE = 36;

/**
 * 128r (妖精大戦争 ～ 東方三月精, GFW) decoder. Ported from Read_128r in threplay.
 * The USER section is read using the old-generation method, but the per-stage
 * breakdown is a hybrid format using the same XOR block decoding + LZSS
 * decompression pipeline as th10 onward.
 */
export function parseTh128(original: Uint8Array): ParsedReplay {
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
  const stage = reader.readAnsiString();
  reader.skip(5);
  const difficulty = reader.readAnsiString();
  reader.skip(6);
  reader.readAnsiString(); // stage (duplicate, also discarded by the original implementation)
  reader.skip(6);
  const score = parseScoreWithTrailingZero(reader.readAnsiString());

  if (original.length < HEADER_SIZE + 4) {
    throw new ReplayCorruptError("file too short for 128r header");
  }
  const length = readBufferedUint32LE(original, 28);
  const dlength = readBufferedUint32LE(original, 32);
  const workBuffer = original.slice(HEADER_SIZE);
  xorBlockDecode(workBuffer, length, 0x800, 0x5e, 0xe7);
  xorBlockDecode(workBuffer, length, 0x80, 0x7d, 0x36);
  const decodedata = decompress(workBuffer, length, dlength);

  const splits: ReplayStageSplit[] = [];
  let stageOffset = 0x70;
  const stageCount = decodedata[0x58] ?? 0;
  for (let i = 0; i < stageCount; i++) {
    const split = emptySplit();
    split.score = readBufferedUint32LE(decodedata, stageOffset + 0xc) * 10;
    split.power = String(readBufferedUint32LE(decodedata, stageOffset + 0x10) + 1);
    // th128 records lives/bombs as a percentage gauge rather than a count
    // (ReplayResourceCount.count holds the percentage, maxPieces is fixed at 100).
    split.lives = resourceCount(Math.trunc(readBufferedUint32LE(decodedata, stageOffset + 0x80) / 100), null, 100);
    split.bombs = resourceCount(Math.trunc(readBufferedUint32LE(decodedata, stageOffset + 0x84) / 100), null, 100);
    const freezeArea = readFloat32LE(decodedata, stageOffset + 0x88);
    split.additional = { freezeAreaPercent: Math.trunc(freezeArea) };
    splits.push(split);
    stageOffset += readBufferedUint32LE(decodedata, stageOffset + 0x8) + 0x90;
  }

  return {
    game: "th128",
    gameTitle: REPLAY_GAME_TITLES.th128,
    formatVersion: null,
    player: normalizeText(name),
    date: normalizeText(date),
    character: null,
    difficulty: normalizeText(difficulty),
    stage: normalizeText(stage),
    score,
    cleared: null,
    splits,
  };
}

function readFloat32LE(buffer: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > buffer.length) {
    throw new ReplayCorruptError(`readFloat32LE out of range at ${offset}`);
  }
  return new DataView(buffer.buffer, buffer.byteOffset + offset, 4).getFloat32(0, true);
}
