import { ByteReader } from "../byte-reader.js";
import { ReplayCorruptError } from "../errors.js";
import { additiveKeyDecode, decompress, readBufferedUint32LE } from "../lzss.js";
import { jumpToUser, parseIntStrict } from "../userdata.js";
import { emptySplit, normalizeText, resourceCount, type ParsedReplay, type ReplayStageSplit } from "../types.js";
import { REPLAY_GAME_TITLES } from "../game-ids.js";

const HEADER_SIZE = 0x68;
const SCORE_OFFSET_COUNT = 9;

/**
 * T8RP (東方永夜抄) デコーダ。threplay の Read_T8RP を移植。
 */
export function parseTh08(original: Uint8Array): ParsedReplay {
  const reader = new ByteReader(original);
  jumpToUser(reader, 12);

  reader.readUint32LE();
  reader.skip(17);
  const name = reader.readAnsiString();
  reader.skip(11);
  const date = reader.readAnsiString();
  reader.skip(9);
  const character = reader.readAnsiString();
  reader.skip(8);
  const score = parseIntStrict(reader.readAnsiString());
  reader.skip(8);
  const difficulty = reader.readAnsiString();
  const stage = reader.readAnsiString();

  if (original.length < HEADER_SIZE + 0x20 + SCORE_OFFSET_COUNT * 4) {
    throw new ReplayCorruptError("file too short for T8RP header");
  }
  const buffer = original.slice();
  const length = readBufferedUint32LE(buffer, 0x0c);
  additiveKeyDecode(buffer, 24, buffer[0x15]!, 7);
  const dlength = readBufferedUint32LE(buffer, 0x1c);

  const scoreOffsets: number[] = [];
  let maxStage = 0;
  for (let i = 0; i < SCORE_OFFSET_COUNT; i++) {
    const offset = readBufferedUint32LE(buffer, 0x20 + 4 * i);
    scoreOffsets.push(offset);
    if (offset !== 0) maxStage = i;
  }

  const shifted = buffer.slice(HEADER_SIZE);
  const decodeData = decompress(shifted, length - HEADER_SIZE, dlength);

  const splits: ReplayStageSplit[] = [];
  // USER セクションの stage フィールドに "Clear" と明記される（真の最終戦到達を
  // 示す score_offsets の最終スロットより、全ルート・エンディングを網羅できて信頼できる）。
  const cleared = stage.includes("Clear");
  if (maxStage === SCORE_OFFSET_COUNT - 1) {
    const offset = scoreOffsets[SCORE_OFFSET_COUNT - 1]! - HEADER_SIZE;
    splits.push(readSplit(decodeData, offset, 7, null));
  } else {
    for (let i = 0; i <= maxStage; i++) {
      if (scoreOffsets[i] === 0) continue;
      const offset = scoreOffsets[i]! - HEADER_SIZE;
      splits.push(readSplit(decodeData, offset, stageNumberFor(i), stageLabelFor(i)));
    }
  }

  return {
    game: "th08",
    gameTitle: REPLAY_GAME_TITLES.th08,
    formatVersion: null,
    player: normalizeText(name),
    date: normalizeText(date),
    character: normalizeText(character),
    difficulty: normalizeText(difficulty),
    stage: normalizeText(stage),
    score,
    cleared,
    splits,
  };
}

function stageNumberFor(index: number): number {
  switch (index) {
    case 3:
    case 4:
      return 4;
    case 5:
      return 5;
    case 6:
    case 7:
      return 6;
    default:
      return index + 1;
  }
}

function stageLabelFor(index: number): string | null {
  switch (index) {
    case 3:
      return "4A";
    case 4:
      return "4B";
    case 6:
      return "6A";
    case 7:
      return "6B";
    default:
      return null;
  }
}

function readSplit(decodeData: Uint8Array, offset: number, stage: number, route: string | null): ReplayStageSplit {
  const split = emptySplit();
  split.stage = stage;
  split.score = readBufferedUint32LE(decodeData, offset) * 10;
  const pointItems = readBufferedUint32LE(decodeData, offset + 0x4);
  const time = readBufferedUint32LE(decodeData, offset + 0xc);
  split.additional = route ? { pointItems, time, route } : { pointItems, time };
  split.graze = readBufferedUint32LE(decodeData, offset + 0x8);
  split.piv = readBufferedUint32LE(decodeData, offset + 0x14);
  split.power = String(decodeData[offset + 0x1c] ?? 0);
  split.lives = resourceCount(decodeData[offset + 0x1d] ?? 0);
  split.bombs = resourceCount(decodeData[offset + 0x1e] ?? 0);
  return split;
}
