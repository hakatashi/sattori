import { decodeAnsiText } from "../byte-reader.js";
import { ReplayCorruptError } from "../errors.js";
import { additiveKeyDecode, readBufferedUint32LE } from "../lzss.js";
import { emptySplit, normalizeText, resourceCount, type ParsedReplay, type ReplayStageSplit } from "../types.js";
import { REPLAY_GAME_TITLES } from "../game-ids.js";

const CHARACTERS = ["ReimuA", "ReimuB", "MarisaA", "MarisaB"];
const DIFFICULTIES = ["Easy", "Normal", "Hard", "Lunatic", "Extra"];

function readNullTerminatedAnsi(buffer: Uint8Array, start: number): { text: string; end: number } {
  let end = start;
  while (true) {
    if (end >= buffer.length) {
      throw new ReplayCorruptError(`unterminated string starting at ${start}`);
    }
    if (buffer[end] === 0x00) break;
    end++;
  }
  return { text: decodeAnsiText(buffer.subarray(start, end)), end };
}

/**
 * T6RP (東方紅魔郷) デコーダ。threplay の Read_T6RP を移植。
 * ヘッダは単純な加算キー方式（key を +7 ずつ更新しつつ減算）で復号される。
 */
export function parseTh06(original: Uint8Array): ParsedReplay {
  if (original.length < 0x38) {
    throw new ReplayCorruptError("file too short for T6RP header");
  }
  const buffer = original.slice();

  const characterIndex = buffer[0x06]!;
  const difficultyIndex = buffer[0x07]!;
  const character = CHARACTERS[characterIndex] ?? null;
  const difficulty = DIFFICULTIES[difficultyIndex] ?? null;

  additiveKeyDecode(buffer, 0x0f, buffer[0x0e]!, 7);

  const { text: date, end: afterDate } = readNullTerminatedAnsi(buffer, 0x10);
  const { text: name } = readNullTerminatedAnsi(buffer, Math.max(afterDate + 1, 0x19));

  const score = readBufferedUint32LE(buffer, 0x24);

  const scoreOffsets: number[] = [];
  let maxStage = 0;
  for (let i = 0; i < 7; i++) {
    const offset = readBufferedUint32LE(buffer, 0x34 + 4 * i);
    scoreOffsets.push(offset);
    if (offset !== 0) maxStage = i;
  }

  const splits: ReplayStageSplit[] = [];
  if (maxStage === 6) {
    const offset = scoreOffsets[6]!;
    const split = readStageSplit(buffer, offset, 7);
    splits.push(split);
  } else {
    for (let i = 0; i <= maxStage; i++) {
      const offset = scoreOffsets[i]!;
      if (offset === 0) continue;
      splits.push(readStageSplit(buffer, offset, i + 1));
    }
  }

  return {
    game: "th06",
    gameTitle: REPLAY_GAME_TITLES.th06,
    formatVersion: null,
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

function readStageSplit(buffer: Uint8Array, offset: number, stage: number): ReplayStageSplit {
  const split = emptySplit();
  split.stage = stage;
  split.score = readBufferedUint32LE(buffer, offset);
  split.power = String(buffer[offset + 0x8] ?? 0);
  split.lives = resourceCount(buffer[offset + 0x9] ?? 0);
  split.bombs = resourceCount(buffer[offset + 0xa] ?? 0);
  split.additional = { rank: buffer[offset + 0xb] ?? 0 };
  return split;
}
