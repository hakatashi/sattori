import { decodeAnsiText } from "../byte-reader.js";
import { localizeCharacterName } from "../character-names.js";
import { ReplayCorruptError } from "../errors.js";
import { additiveKeyDecode, readBufferedUint32LE } from "../lzss.js";
import { DATE_TOKENS_MDY, parseDateComponents } from "../date-format.js";
import { emptySplit, normalizeText, resourceCount, type ParsedReplay, type ReplayStageSplit } from "../types.js";
import { REPLAY_GAME_TITLES, type ReplayGameId } from "../game-ids.js";

const CHARACTERS = ["ReimuA", "ReimuB", "MarisaA", "MarisaB"];
const DIFFICULTIES = ["Easy", "Normal", "Hard", "Lunatic", "Extra"];

/**
 * Size of the fixed per-stage header preceding each stage's raw input-change
 * log, and the size of each record within that log, for the *original* th06.
 * Confirmed exactly (not just empirically) via `GensokyoClub/th06`'s
 * decompilation of the game's `StageReplayData`/`ReplayDataInput` structs
 * (`src/ReplayData.hpp`): `ZUN_ASSERT_SIZE(StageReplayData, 0x69780)` matches
 * `STAGE_INPUT_LOG_HEADER_SIZE + 53998 * STAGE_INPUT_RECORD_SIZE` exactly
 * (0x69780 = 16 + 53998*8), and the header's field layout (score/power/
 * lives/bombs/rank at 0x0/0x8/0x9/0xa/0xb) matches what this package already
 * reads. Unlike th07/th08 (which run on a later, LZSS-compressed engine and
 * log one fixed-width record per frame — see games/th07.ts), th06 (the
 * first main-series title) stores an uncompressed sparse log of *input
 * change events*: `ReplayDataInput { frameNum: i32; inputKey: u16; padding:
 * u16 }`, one record only when the held key combination actually changes,
 * not once per frame.
 *
 * The two 2026 remakes keep this shape but widen it — see `TH06C`/`TH06NC`.
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
 * number. Both remakes reuse the same literal sentinel.
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

/**
 * Everything that differs between the original th06 and its two 2026 remakes
 * (東方紅魔郷: Classic / 東方紅魔郷: New Classic). All three share the `T6RP`
 * magic, the additive-key header obfuscation and the overall "fixed header →
 * per-stage snapshot → sparse input-change log" shape; the remakes are 64-bit
 * rebuilds, so their pointer-sized and score fields widened and everything
 * after them shifted. See `docs/research/th06-classic-replay-format.md` for
 * how each field below was determined.
 */
interface Th06Layout {
  game: ReplayGameId;
  /** Offset of the additive-decode key byte. The obfuscated body starts right after it. */
  keyOffset: number;
  /** `MM/DD/YY`, NUL-terminated. */
  dateOffset: number;
  /** Player name, NUL-terminated, immediately after `dateOffset`'s 9-byte field. */
  nameOffset: number;
  /**
   * Game mode (`MODES`). Only th06nc records one — the original and Classic
   * have no mode concept, so this is `null` for them.
   */
  modeOffset: number | null;
  /** Shot type, an index into `CHARACTERS`. */
  characterOffset: number;
  /**
   * Difficulty, an index into `DIFFICULTIES`. Widened to 4 bytes in th06nc,
   * where the same field doubles as the spell card index in Spell Practice
   * mode (see `readModeAndStage`).
   */
  difficultyOffset: number;
  difficultyWidth: 1 | 4;
  scoreOffset: number;
  scoreWidth: 4 | 8;
  /** Start of the 7-entry array of absolute per-stage offsets (index 6 = Extra). */
  stageOffsetsOffset: number;
  stageOffsetWidth: 4 | 8;
  /** Bytes of per-stage snapshot preceding that stage's input log. */
  stageHeaderSize: number;
  /** Offset of `power` within the stage header; `lives`/`bombs` follow it. */
  splitPowerOffset: number;
  /** Offset of the internal rank byte within the stage header, or `null` if not recorded. */
  splitRankOffset: number | null;
  inputRecordSize: number;
  /** Offset of `frameNum` within an input record. */
  inputRecordFrameOffset: number;
}

/** 東方紅魔郷 (the original, versions up to 1.02h). */
const TH06: Th06Layout = {
  game: "th06",
  keyOffset: 0x0e,
  dateOffset: 0x10,
  nameOffset: 0x19,
  modeOffset: null,
  characterOffset: 0x06,
  difficultyOffset: 0x07,
  difficultyWidth: 1,
  scoreOffset: 0x24,
  scoreWidth: 4,
  stageOffsetsOffset: 0x34,
  stageOffsetWidth: 4,
  stageHeaderSize: STAGE_INPUT_LOG_HEADER_SIZE,
  splitPowerOffset: 0x08,
  splitRankOffset: 0x0b,
  inputRecordSize: STAGE_INPUT_RECORD_SIZE,
  inputRecordFrameOffset: 0x00,
};

/**
 * 東方紅魔郷: Classic (2026, reports itself as "ver. 1.03" in game). A
 * faithful re-implementation, and its replay format is byte-identical to
 * th06's up to the stage offset array: same key offset, same date/name/score
 * offsets, same `1.12 + slowdown` / `slowdown` / `2.34 + slowdown` float
 * triple at 0x28/0x2c/0x30, and the same 0x3f000318-seeded checksum at 0x08.
 * From there it is a 64-bit rebuild: the stage offsets became `u64` (so the
 * array is padded to an 8-byte boundary at 0x38, leaving 0x34 unused), the
 * per-stage snapshot grew from 0x10 to 0x20 bytes, and an input record grew
 * from 8 to 12 bytes — `{ inputKey: u32; previousInputKey: u32; frameNum:
 * u32 }`, i.e. `frameNum` moved from the front of the record to its end.
 */
const TH06C: Th06Layout = {
  ...TH06,
  game: "th06c",
  stageOffsetsOffset: 0x38,
  stageOffsetWidth: 8,
  stageHeaderSize: 0x20,
  inputRecordSize: 12,
  inputRecordFrameOffset: 0x08,
};

/**
 * 東方紅魔郷: New Classic (2026). Same overall shape as `TH06C`, but the
 * header gained a mode byte at 0x06 and a 4-byte difficulty at 0x08, which
 * pushes everything from the checksum onward 4 bytes later; the score then
 * widened to `u64`, shifting the float triple and the stage offset array by
 * another 4. The per-stage snapshot is 0x24 bytes (score is `u64` here too),
 * and its rank byte is gone: the byte in the position th06/th06c use for
 * rank reads 0 in every stage of every fixture, so nothing is exposed for it.
 */
const TH06NC: Th06Layout = {
  game: "th06nc",
  keyOffset: 0x12,
  dateOffset: 0x14,
  nameOffset: 0x1d,
  modeOffset: 0x06,
  characterOffset: 0x07,
  difficultyOffset: 0x08,
  difficultyWidth: 4,
  scoreOffset: 0x28,
  scoreWidth: 8,
  stageOffsetsOffset: 0x40,
  stageOffsetWidth: 8,
  stageHeaderSize: 0x24,
  splitPowerOffset: 0x0c,
  splitRankOffset: null,
  inputRecordSize: 12,
  inputRecordFrameOffset: 0x08,
};

/**
 * The `u16` at 0x04 is the only thing telling the three titles apart (the
 * magic and the surrounding bytes are identical), so an unknown value has to
 * fall back rather than guess a layout: anything that isn't a known remake is
 * treated as the original th06, matching how this package behaved before the
 * remakes existed (older th06 builds write 0x0100/0x0101 there).
 */
const VARIANTS_BY_VERSION = new Map<number, Th06Layout>([
  [0x0103, TH06C],
  [0x010f, TH06NC],
]);

/**
 * th06nc's game modes, indexed by the byte at `Th06Layout.modeOffset`.
 * `Standard` is the original game's rules; `Challenge` removes lives and
 * counts hits instead; `SpellPractice` is a single spell card, as in th08.
 * Index 2 has not been observed in any replay — most likely stage practice,
 * but this package does not claim so without a sample, and an unrecognized
 * mode is surfaced verbatim (`"Mode 2"`) rather than silently dropped.
 */
const MODES = ["Standard", "Challenge", undefined, "SpellPractice"];

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
 * Reads a little-endian unsigned integer of 4 or 8 bytes as a `number`. The
 * 8-byte case is only used for th06nc's score and stage offsets, both of
 * which are far below 2^53 in practice, but a corrupted file could still
 * carry a value that cannot be represented exactly — reject those rather
 * than return a silently rounded offset.
 */
function readUint(buffer: Uint8Array, offset: number, width: 1 | 4 | 8): number {
  if (width === 1) {
    const value = buffer[offset];
    if (value === undefined) {
      throw new ReplayCorruptError(`readUint out of range at ${offset} (length ${buffer.length})`);
    }
    return value;
  }
  const low = readBufferedUint32LE(buffer, offset);
  if (width === 4) return low;
  const high = readBufferedUint32LE(buffer, offset + 4);
  const value = high * 0x1_0000_0000 + low;
  if (!Number.isSafeInteger(value)) {
    throw new ReplayCorruptError(`64-bit value at ${offset} is too large to represent exactly`);
  }
  return value;
}

/**
 * T6RP (東方紅魔郷, EoSD) decoder, covering the original game and its two 2026
 * remakes (東方紅魔郷: Classic / New Classic — see `Th06Layout`). Ported from
 * Read_T6RP in threplay. The header is decoded with a simple additive-key
 * scheme (subtracting a key that is updated by +7 each step).
 */
export function parseTh06(original: Uint8Array): ParsedReplay {
  if (original.length < 0x06) {
    throw new ReplayCorruptError("file too short for T6RP header");
  }
  const formatVersion = original[0x04]! | (original[0x05]! << 8);
  const layout = VARIANTS_BY_VERSION.get(formatVersion) ?? TH06;

  const headerEnd = layout.stageOffsetsOffset + layout.stageOffsetWidth * 7;
  if (original.length < headerEnd) {
    throw new ReplayCorruptError("file too short for T6RP header");
  }
  const buffer = original.slice();

  const character = CHARACTERS[buffer[layout.characterOffset]!] ?? null;
  const { ja: characterNameJa, en: characterNameEn } = localizeCharacterName(layout.game, character);

  additiveKeyDecode(buffer, layout.keyOffset + 1, buffer[layout.keyOffset]!, 7);

  const { text: date, end: afterDate } = readNullTerminatedAnsi(buffer, layout.dateOffset);
  const { text: name } = readNullTerminatedAnsi(buffer, Math.max(afterDate + 1, layout.nameOffset));

  const score = readUint(buffer, layout.scoreOffset, layout.scoreWidth);

  const { difficulty, stage } = readModeAndStage(original, layout);

  const stageOffsets: number[] = [];
  let maxStage = 0;
  for (let i = 0; i < 7; i++) {
    const offset = readUint(buffer, layout.stageOffsetsOffset + layout.stageOffsetWidth * i, layout.stageOffsetWidth);
    stageOffsets.push(offset);
    if (offset !== 0) maxStage = i;
  }

  const checkpoints: { offset: number; stage: number }[] = [];
  if (maxStage === 6) {
    checkpoints.push({ offset: stageOffsets[6]!, stage: 7 });
  } else {
    for (let i = 0; i <= maxStage; i++) {
      const offset = stageOffsets[i]!;
      if (offset === 0) continue;
      checkpoints.push({ offset, stage: i + 1 });
    }
  }
  const stageFrameCounts = perStageFrameCounts(
    buffer,
    layout,
    checkpoints.map((c) => c.offset),
  );
  const splits: ReplayStageSplit[] = checkpoints.map(({ offset, stage: stageNumber }, i) => {
    const split = readStageSplit(buffer, layout, offset, stageNumber);
    split.frameCount = stageFrameCounts[i]!;
    return split;
  });

  return {
    game: layout.game,
    gameTitle: REPLAY_GAME_TITLES[layout.game],
    formatVersion,
    player: normalizeText(name),
    date: normalizeText(date),
    parsedDate: parseDateComponents(normalizeText(date), DATE_TOKENS_MDY),
    recordedAt: null,
    character,
    characterNameJa,
    characterNameEn,
    difficulty,
    stage,
    score,
    // th07 (games/th07.ts) has the identical stageOffsets/maxStage layout and
    // it turned out maxStage only indicates which stage was *reached*, not
    // cleared — th07 has a separate 1-byte clear flag found empirically via
    // a game-over fixture, but no equivalent has been verified for any of the
    // three th06 variants (no "reached the final stage without clearing"
    // fixture exists yet, and a byte-wise scan over the th06c/th06nc fixtures
    // found nothing that separates their cleared runs from their game-overs).
    // Left null rather than guessing.
    cleared: null,
    loadout: null,
    splits,
    frameCount: stageFrameCounts.length === 0 ? null : stageFrameCounts.reduce((a, b) => a + b, 0),
  };
}

/**
 * Reads the difficulty and, for th06nc, the game mode — which share a field.
 * In Spell Practice mode th06nc reuses the difficulty slot for the 0-based
 * spell card index instead, so the difficulty of such a replay simply isn't
 * recoverable from the file (there is no second copy of it anywhere in the
 * header) and is reported as `null`.
 *
 * The mode is surfaced through `stage` rather than a field of its own,
 * following how th20 reports Spell Practice (see `spellPracticeStage` in
 * games/th20.ts). `Standard` maps to `null` so that ordinary th06nc replays
 * read the same as th06/th06c ones.
 *
 * Note this reads the *undecoded* buffer: every field it touches lives before
 * the obfuscated region.
 */
function readModeAndStage(
  original: Uint8Array,
  layout: Th06Layout,
): { difficulty: string | null; stage: string | null } {
  const rawDifficulty = readUint(original, layout.difficultyOffset, layout.difficultyWidth);
  if (layout.modeOffset === null) {
    return { difficulty: DIFFICULTIES[rawDifficulty] ?? null, stage: null };
  }

  const rawMode = original[layout.modeOffset]!;
  const mode = MODES[rawMode];
  if (mode === "SpellPractice") {
    // The number the game's own Spell Practice menu shows is 1-based.
    return { difficulty: null, stage: `Spell Practice No. ${rawDifficulty + 1}` };
  }
  return {
    difficulty: DIFFICULTIES[rawDifficulty] ?? null,
    stage: mode === undefined ? `Mode ${rawMode}` : mode === "Standard" ? null : mode,
  };
}

function readStageSplit(buffer: Uint8Array, layout: Th06Layout, offset: number, stage: number): ReplayStageSplit {
  const split = emptySplit();
  const power = layout.splitPowerOffset;
  split.stage = stage;
  split.score = readUint(buffer, offset, layout.scoreWidth);
  split.power = String(buffer[offset + power] ?? 0);
  split.lives = resourceCount(buffer[offset + power + 1] ?? 0);
  split.bombs = resourceCount(buffer[offset + power + 2] ?? 0);
  split.additional =
    layout.splitRankOffset === null ? null : { rank: buffer[offset + layout.splitRankOffset] ?? 0 };
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
function perStageFrameCounts(buffer: Uint8Array, layout: Th06Layout, checkpointOffsets: number[]): number[] {
  return checkpointOffsets.map((offset, i) => {
    const start = offset + layout.stageHeaderSize;
    const end = i + 1 < checkpointOffsets.length ? checkpointOffsets[i + 1]! : buffer.length;
    const recordCount = Math.max(0, Math.floor((end - start) / layout.inputRecordSize));

    let lastRealFrameNum = 0;
    for (let r = 0; r < recordCount; r++) {
      const frameNum =
        readBufferedUint32LE(buffer, start + r * layout.inputRecordSize + layout.inputRecordFrameOffset) | 0;
      if (frameNum >= INPUT_LOG_SENTINEL_FRAME_NUM) break;
      lastRealFrameNum = frameNum;
    }
    return lastRealFrameNum;
  });
}
