import { decodeAnsiText } from "../byte-reader.js";
import { localizeCharacterName } from "../character-names.js";
import { ReplayCorruptError } from "../errors.js";
import { additiveKeyDecode, readBufferedUint32LE } from "../lzss.js";
import { DATE_TOKENS_MDY, parseDateComponents } from "../date-format.js";
import { emptySplit, normalizeText, resourceCount, type ParsedReplay, type ReplayStageSplit } from "../types.js";
import { REPLAY_GAME_TITLES } from "../game-ids.js";

const CHARACTERS = ["ReimuA", "ReimuB", "MarisaA", "MarisaB"];
const DIFFICULTIES = ["Easy", "Normal", "Hard", "Lunatic", "Extra"];

/**
 * Size of the fixed per-stage header preceding each stage's raw input-change
 * log, and the size of each record within that log. Confirmed exactly (not
 * just empirically) via `GensokyoClub/th06`'s decompilation of the game's
 * `StageReplayData`/`ReplayDataInput` structs (`src/ReplayData.hpp`):
 * `ZUN_ASSERT_SIZE(StageReplayData, 0x69780)` matches
 * `STAGE_INPUT_LOG_HEADER_SIZE + 53998 * STAGE_INPUT_RECORD_SIZE` exactly
 * (0x69780 = 16 + 53998*8), and the header's field layout (score/power/
 * lives/bombs/rank at 0x0/0x8/0x9/0xa/0xb) matches what this package already
 * reads. Unlike th07/th08 (which run on a later, LZSS-compressed engine and
 * log one fixed-width record per frame — see games/th07.ts), th06 (the
 * first main-series title) stores an uncompressed sparse log of *input
 * change events*: `ReplayDataInput { frameNum: i32; inputKey: u16; padding:
 * u16 }`, one record only when the held key combination actually changes,
 * not once per frame.
 */
const STAGE_INPUT_LOG_HEADER_SIZE = 0x10;
/** See `STAGE_INPUT_LOG_HEADER_SIZE`. */
const STAGE_INPUT_RECORD_SIZE = 8;
/**
 * Sentinel `frameNum` value the game writes to terminate a stage's input
 * log (observed as literal `9999999`, always immediately following the
 * final real event; the very last stage of a replay additionally repeats
 * the pair once more — e.g. `[..., N, 9999999, N, 9999999]` — while every
 * other stage terminates with a single `N, 9999999`). Any value at or above
 * this threshold is treated as the terminator rather than a real frame
 * number.
 *
 * The resulting per-stage frame counts were additionally cross-validated
 * against two real recorded replays not checked into this repo (their
 * players are not this package's author, so they can't be added to
 * `test-fixtures/`, per the copyright policy in this package's README):
 * a single-stage (Extra) clear computed to ~903s against an independently
 * known end-to-end recording of ~864s, and a 6-stage clear computed to
 * ~2065s against a known ~2046s — both within a few percent, consistent
 * with `frameCount` excluding recording-pipeline overhead in one case and
 * this event log not capturing any trailing frames after the last input
 * change in a stage in the other (see `ParsedReplay.frameCount`).
 */
const INPUT_LOG_SENTINEL_FRAME_NUM = 9_000_000;

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
 * T6RP (東方紅魔郷, EoSD) decoder. Ported from Read_T6RP in threplay.
 * The header is decoded with a simple additive-key scheme (subtracting a key
 * that is updated by +7 each step).
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
  const { ja: characterNameJa, en: characterNameEn } = localizeCharacterName("th06", character);

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

  const checkpoints: { offset: number; stage: number }[] = [];
  if (maxStage === 6) {
    checkpoints.push({ offset: scoreOffsets[6]!, stage: 7 });
  } else {
    for (let i = 0; i <= maxStage; i++) {
      const offset = scoreOffsets[i]!;
      if (offset === 0) continue;
      checkpoints.push({ offset, stage: i + 1 });
    }
  }
  const stageFrameCounts = perStageFrameCounts(
    buffer,
    checkpoints.map((c) => c.offset),
  );
  const splits: ReplayStageSplit[] = checkpoints.map(({ offset, stage }, i) => {
    const split = readStageSplit(buffer, offset, stage);
    split.frameCount = stageFrameCounts[i]!;
    return split;
  });

  return {
    game: "th06",
    gameTitle: REPLAY_GAME_TITLES.th06,
    formatVersion: null,
    player: normalizeText(name),
    date: normalizeText(date),
    parsedDate: parseDateComponents(normalizeText(date), DATE_TOKENS_MDY),
    recordedAt: null,
    character,
    characterNameJa,
    characterNameEn,
    difficulty,
    stage: null,
    score,
    // th07 (games/th07.ts) has the identical scoreOffsets/maxStage layout and
    // it turned out maxStage only indicates which stage was *reached*, not
    // cleared — th07 has a separate 1-byte clear flag found empirically via
    // a game-over fixture, but no equivalent has been verified for th06 (no
    // "reached the final stage without clearing" th06 fixture exists yet, and
    // the byte immediately after th06's score field, unlike th07's, isn't a
    // clean 0/1 value). Left null rather than guessing.
    cleared: null,
    loadout: null,
    splits,
    frameCount: stageFrameCounts.length === 0 ? null : stageFrameCounts.reduce((a, b) => a + b, 0),
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

/**
 * Returns each stage's `frameCount`, in the same order as
 * `checkpointOffsets`. Unlike th07/th08 (a fixed byte-length division is
 * enough there, see `perCheckpointFrameCounts` in games/th07.ts), th06's log
 * only records *input-change events*, so the frame count isn't the record
 * count — it's the `frameNum` of the last real record before that stage's
 * terminator sentinel (see `INPUT_LOG_SENTINEL_FRAME_NUM`). `frameNum` resets
 * to (approximately) 0 at the start of every stage, confirmed against
 * `test-fixtures/th06/th6_02.rpy` (each of its 6 stages starts with
 * `frameNum: 0`).
 */
function perStageFrameCounts(buffer: Uint8Array, checkpointOffsets: number[]): number[] {
  return checkpointOffsets.map((offset, i) => {
    const start = offset + STAGE_INPUT_LOG_HEADER_SIZE;
    const end = i + 1 < checkpointOffsets.length ? checkpointOffsets[i + 1]! : buffer.length;
    const recordCount = Math.max(0, Math.floor((end - start) / STAGE_INPUT_RECORD_SIZE));

    let lastRealFrameNum = 0;
    for (let r = 0; r < recordCount; r++) {
      const frameNum = readBufferedUint32LE(buffer, start + r * STAGE_INPUT_RECORD_SIZE) | 0;
      if (frameNum >= INPUT_LOG_SENTINEL_FRAME_NUM) break;
      lastRealFrameNum = frameNum;
    }
    return lastRealFrameNum;
  });
}
