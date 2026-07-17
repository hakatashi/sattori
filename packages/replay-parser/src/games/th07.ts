import { decodeAnsiText } from "../byte-reader.js";
import { ReplayCorruptError } from "../errors.js";
import { additiveKeyDecode, decompress, readBufferedUint32LE } from "../lzss.js";
import { emptySplit, normalizeText, resourceCount, type ParsedReplay, type ReplayStageSplit } from "../types.js";
import { REPLAY_GAME_TITLES } from "../game-ids.js";

const CHARACTERS = ["ReimuA", "ReimuB", "MarisaA", "MarisaB", "SakuyaA", "SakuyaB"];
const DIFFICULTIES = ["Easy", "Normal", "Hard", "Lunatic", "Extra", "Phantasm"];

const HEADER_SIZE = 0x54;

/**
 * T7RP (東方妖々夢) デコーダ。threplay の Read_T7RP を移植。
 *
 * ヘッダオフセット 0x07 は、過去に録画用バイナリと再生できないリプレイ
 * バージョンが存在することが本番運用で判明した際の手がかり（Issue #16、
 * 現在は録画用ゲームバイナリ側のバージョンアップにより解消済み）。
 * このパッケージでは値の意味を断定せず、生の formatVersion として
 * 返すのみに留める。
 */
export function parseTh07(original: Uint8Array): ParsedReplay {
  if (original.length < HEADER_SIZE + 4) {
    throw new ReplayCorruptError("file too short for T7RP header");
  }
  const buffer = original.slice();
  const formatVersion = buffer[0x07]!;

  additiveKeyDecode(buffer, 16, buffer[0x0d]!, 7);

  const length = readBufferedUint32LE(buffer, 20);
  const dlength = readBufferedUint32LE(buffer, 24);

  const scoreOffsets: number[] = [];
  let maxStage = 0;
  for (let i = 0; i < 7; i++) {
    const offset = readBufferedUint32LE(buffer, 0x1c + 4 * i);
    scoreOffsets.push(offset);
    if (offset !== 0) maxStage = i;
  }

  if (HEADER_SIZE > buffer.length) {
    throw new ReplayCorruptError("T7RP body shorter than header size");
  }
  const shifted = buffer.slice(HEADER_SIZE);
  const decodeData = decompress(shifted, length, dlength);
  if (decodeData.length < 25) {
    throw new ReplayCorruptError("T7RP decompressed body too short");
  }

  const character = CHARACTERS[decodeData[2]!] ?? null;
  const difficulty = DIFFICULTIES[decodeData[3]!] ?? null;
  const date = decodeAnsiText(decodeData.subarray(4, 9));
  const name = decodeAnsiText(decodeData.subarray(10, 18));
  const score = readBufferedUint32LE(decodeData, 24) * 10;

  const splits: ReplayStageSplit[] = [];
  if (maxStage === 6) {
    const offset = scoreOffsets[6]!;
    splits.push(readClearSplit(decodeData, offset));
  } else {
    for (let i = 0; i <= maxStage; i++) {
      const raw = scoreOffsets[i]!;
      if (raw === 0) continue;
      splits.push(readStageSplit(decodeData, raw - HEADER_SIZE, i + 1));
    }
  }

  return {
    game: "th07",
    gameTitle: REPLAY_GAME_TITLES.th07,
    formatVersion,
    player: normalizeText(name),
    date: normalizeText(date),
    character,
    difficulty,
    stage: null,
    score,
    cleared: maxStage === 6,
    splits,
  };
}

function readClearSplit(decodeData: Uint8Array, offset: number): ReplayStageSplit {
  return readSplitCommon(decodeData, offset, 7);
}

function readStageSplit(decodeData: Uint8Array, offset: number, stage: number): ReplayStageSplit {
  return readSplitCommon(decodeData, offset, stage);
}

function readSplitCommon(decodeData: Uint8Array, offset: number, stage: number): ReplayStageSplit {
  const split = emptySplit();
  split.stage = stage;
  split.score = readBufferedUint32LE(decodeData, offset);
  split.piv = readBufferedUint32LE(decodeData, offset + 0x8);
  const pointItems = readBufferedUint32LE(decodeData, offset + 0x4);
  const cherryMax = readBufferedUint32LE(decodeData, offset + 0xc);
  split.additional = { pointItems, cherryMax };
  split.graze = readBufferedUint32LE(decodeData, offset + 0x14);
  split.power = String(decodeData[offset + 0x22] ?? 0);
  split.lives = resourceCount(decodeData[offset + 0x23] ?? 0);
  split.bombs = resourceCount(decodeData[offset + 0x24] ?? 0);
  return split;
}
