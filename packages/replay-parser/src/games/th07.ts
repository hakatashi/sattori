import { decodeAnsiText } from "../byte-reader.js";
import { ReplayCorruptError } from "../errors.js";
import { additiveKeyDecode, decompress, readBufferedUint32LE } from "../lzss.js";
import { emptySplit, normalizeText, resourceCount, type ParsedReplay, type ReplayStageSplit } from "../types.js";
import { REPLAY_GAME_TITLES } from "../game-ids.js";

const CHARACTERS = ["ReimuA", "ReimuB", "MarisaA", "MarisaB", "SakuyaA", "SakuyaB"];
const DIFFICULTIES = ["Easy", "Normal", "Hard", "Lunatic", "Extra", "Phantasm"];

const HEADER_SIZE = 0x54;

/**
 * Size of the fixed per-checkpoint header preceding each stage's raw input
 * log within the decompressed body (37 bytes of fields actually read by
 * `readSplitCommon`, rounded up to a 4-byte-aligned 40). Combined with
 * `BYTES_PER_FRAME`, this was determined by reverse-engineering the
 * checked-in `test-fixtures/th07/*.rpy` fixtures: for every stage-to-stage
 * checkpoint gap in a multi-stage (non-clear) replay, `(gap - 40) / 4` comes
 * out to an exact integer, and applying the same formula to a single-stage
 * (Extra-clear) replay whose actual recorded duration is independently known
 * (`touhou-recorder` reports/11 and reports/20, both around 840-852s for
 * `th7_07.rpy`) lands within that measured range. Neither threplay nor threp
 * (the sources this package otherwise ports from) documents or parses this
 * input log, so treat this as an empirically-derived model, not a confirmed
 * upstream spec.
 */
const STAGE_CHECKPOINT_HEADER_SIZE = 40;
/** See `STAGE_CHECKPOINT_HEADER_SIZE`. */
const BYTES_PER_FRAME = 4;

/**
 * Offset (within the decompressed body) of a 1-byte flag that is non-zero
 * when the run ended in a full clear and `0` otherwise (game over, or a
 * practice-mode recording that can never count as a clear). Reverse-engineered
 * from `test-fixtures/th07/*.rpy`: the per-stage `scoreOffsets` checkpoints
 * (see below) only indicate which stage was *reached*, not whether the last
 * one reached was actually cleared — `th7_10.rpy` (game over during stage 6)
 * and `th7_11.rpy` (stage-6 practice, never clearable) both populate the same
 * checkpoint slots as a genuine stage-6 clear (`th7_09.rpy`) but differ only
 * in this byte (0 vs 1). Not documented by threplay/threp.
 *
 * The byte isn't strictly boolean: a replay recorded by a different game
 * version (`formatVersion` 3 vs the `5` of the checked-in fixtures), and
 * confirmed by its player to be a continue-free clear, had `2` here instead
 * of `1`. Treat any non-zero value as cleared rather than assuming `1` is the
 * only clear value; what distinguishes `1` from `2` (continue usage?) is
 * unconfirmed and not exposed since `ParsedReplay.cleared` is a boolean.
 */
const CLEAR_FLAG_OFFSET = 28;

/**
 * T7RP (東方妖々夢, PCB) decoder. Ported from Read_T7RP in threplay.
 *
 * Header offset 0x07 was the clue that surfaced in production when it turned
 * out some replay versions could not be played back with the recording
 * binary (Issue #16, since resolved by upgrading the recording game binary).
 * This package does not assume a specific meaning for the value and simply
 * exposes it as the raw formatVersion.
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
  if (decodeData.length < CLEAR_FLAG_OFFSET + 1) {
    throw new ReplayCorruptError("T7RP decompressed body too short");
  }

  const character = CHARACTERS[decodeData[2]!] ?? null;
  const difficulty = DIFFICULTIES[decodeData[3]!] ?? null;
  const date = decodeAnsiText(decodeData.subarray(4, 9));
  const name = decodeAnsiText(decodeData.subarray(10, 18));
  const score = readBufferedUint32LE(decodeData, 24) * 10;

  // checkpoints are decodeData-relative offsets to each stage's score
  // snapshot header, paired with the 1-based stage number that slot
  // corresponds to (index i in scoreOffsets means stage i+1, except slot 6
  // which is the single Extra/Phantasm stage and is reported as stage 7).
  // Each slot holds the last state recorded while that stage was being
  // played — reached, not necessarily cleared (see `CLEAR_FLAG_OFFSET`).
  // The original C# (threplay) used score_offsets[6] directly (without the
  // -HEADER_SIZE adjustment applied to every other index) for the
  // max_stage===6 case — an inconsistency that this port initially carried
  // over as well. That bug caused readSplitCommon to read 0x54 bytes too far
  // into the body, landing inside the raw per-frame input log instead of the
  // checkpoint header (visible in the old golden fixtures as suspiciously
  // uniform values like score=97/piv=97/graze=97). Applying the same
  // -HEADER_SIZE adjustment uniformly here fixes that.
  //
  // Slots are only populated for stages actually reached, in order, so a
  // practice-mode recording of a single stage (e.g. stage 6) leaves earlier
  // slots at 0 and populates only its own slot — the stage number must come
  // from that slot's index, not from its position among the populated slots.
  const checkpoints: { offset: number; stage: number }[] = [];
  if (maxStage === 6) {
    checkpoints.push({ offset: scoreOffsets[6]! - HEADER_SIZE, stage: 7 });
  } else {
    for (let i = 0; i <= maxStage; i++) {
      const raw = scoreOffsets[i]!;
      if (raw === 0) continue;
      checkpoints.push({ offset: raw - HEADER_SIZE, stage: i + 1 });
    }
  }
  const splits: ReplayStageSplit[] = [];
  const stageFrameCounts = perCheckpointFrameCounts(
    decodeData,
    checkpoints.map((c) => c.offset),
  );
  checkpoints.forEach(({ offset, stage }, i) => {
    const split = readSplitCommon(decodeData, offset, stage);
    split.frameCount = stageFrameCounts[i]!;
    splits.push(split);
  });

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
    cleared: decodeData[CLEAR_FLAG_OFFSET] !== 0,
    splits,
    frameCount: stageFrameCounts.length === 0 ? null : stageFrameCounts.reduce((a, b) => a + b, 0),
  };
}

/**
 * Returns the per-frame input log length for each checkpoint-to-checkpoint
 * (or last-checkpoint-to-end-of-body) span, in the same order as
 * `checkpointOffsets`. See `STAGE_CHECKPOINT_HEADER_SIZE` for the model this
 * is based on.
 */
function perCheckpointFrameCounts(decodeData: Uint8Array, checkpointOffsets: number[]): number[] {
  return checkpointOffsets.map((offset, i) => {
    const start = offset + STAGE_CHECKPOINT_HEADER_SIZE;
    const end = i + 1 < checkpointOffsets.length ? checkpointOffsets[i + 1]! : decodeData.length;
    return Math.max(0, Math.floor((end - start) / BYTES_PER_FRAME));
  });
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
