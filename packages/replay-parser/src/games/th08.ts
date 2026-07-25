import { ByteReader } from "../byte-reader.js";
import { ReplayCorruptError } from "../errors.js";
import { additiveKeyDecode, decompress, readBufferedUint32LE } from "../lzss.js";
import { jumpToUser, parseIntStrict } from "../userdata.js";
import { emptySplit, normalizeText, resourceCount, type ParsedReplay, type ReplayStageSplit } from "../types.js";
import { REPLAY_GAME_TITLES } from "../game-ids.js";

const HEADER_SIZE = 0x68;
const SCORE_OFFSET_COUNT = 9;

/**
 * Size of the fixed per-checkpoint header preceding each stage's raw input
 * log within the decompressed body. Confirmed by cross-referencing
 * `GensokyoClub/th08`'s decompilation of the game's `StageReplayData`
 * struct (`src/ReplayManager.hpp`): the fields this package already reads
 * (score/pointItemsCollected/graze/pointItemValue(=piv)/power/lives/bombs at
 * 0x0/0x4/0x8/0x14/0x1c/0x1d/0x1e) match that struct's layout exactly, up to
 * and including a `u8 rank` at 0x1f. The decompiled in-memory struct is
 * 0x40 (64) bytes total (it also carries `character`/`clockTime`/29 bytes of
 * still-unidentified fields), but this package only cares about where the
 * file's serialized per-frame log actually starts, which was located
 * empirically: dumping the raw bytes of `test-fixtures/th08/th8_03.rpy`
 * immediately after each checkpoint's known fields shows a clean, repeating
 * 2-byte-per-record pattern starting at exactly offset 0x28 (40) for every
 * checkpoint inspected (i.e. the file format does not serialize the whole
 * in-memory struct verbatim). The ambiguity between 0x28 and the in-memory
 * 0x40 shifts any computed `frameCount` by at most ~12 frames (~0.2s at
 * 60fps), immaterial at the timescale `frameCount` is meant for.
 */
const STAGE_CHECKPOINT_HEADER_SIZE = 0x28;
/**
 * See `STAGE_CHECKPOINT_HEADER_SIZE`. Determined the same way as th07's
 * `BYTES_PER_FRAME` (games/th07.ts): `(gap - STAGE_CHECKPOINT_HEADER_SIZE) / 2`
 * comes out to an exact integer for every stage-to-stage checkpoint gap in
 * `test-fixtures/th08/th8_03.rpy` and `th8_06.rpy`. Cross-validated against
 * real recorded durations (`touhou-recorder` PoC replays, not checked into
 * this repo): a single-segment Extra-stage clear computes to ~775s against
 * an independently known end-to-end recording of ~786s, and a short
 * spell-practice replay computes to ~37s against a known ~40s recording —
 * both undershoots are consistent with `frameCount` deliberately excluding
 * recording-pipeline overhead (menu automation, end-of-replay detection
 * lag) layered on top by a consumer such as Sattori's worker (see
 * `ParsedReplay.frameCount`).
 */
const BYTES_PER_FRAME = 2;

/**
 * T8RP (東方永夜抄, IN) decoder. Ported from Read_T8RP in threplay.
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

  // The USER section's stage field explicitly contains "Clear" — this is more
  // reliable than the final score_offsets slot (which indicates reaching the
  // true final battle) because it covers all routes and endings.
  const cleared = stage.includes("Clear");
  const checkpoints: { offset: number; stage: number; route: string | null }[] = [];
  if (maxStage === SCORE_OFFSET_COUNT - 1) {
    checkpoints.push({ offset: scoreOffsets[SCORE_OFFSET_COUNT - 1]! - HEADER_SIZE, stage: 7, route: null });
  } else {
    for (let i = 0; i <= maxStage; i++) {
      if (scoreOffsets[i] === 0) continue;
      checkpoints.push({ offset: scoreOffsets[i]! - HEADER_SIZE, stage: stageNumberFor(i), route: stageLabelFor(i) });
    }
  }
  const stageFrameCounts = perCheckpointFrameCounts(
    decodeData,
    checkpoints.map((c) => c.offset),
  );
  const splits: ReplayStageSplit[] = checkpoints.map(({ offset, stage: stageNumber, route }, i) => {
    const split = readSplit(decodeData, offset, stageNumber, route);
    split.frameCount = stageFrameCounts[i]!;
    return split;
  });

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
    frameCount: stageFrameCounts.length === 0 ? null : stageFrameCounts.reduce((a, b) => a + b, 0),
  };
}

/**
 * Returns the per-frame input log length for each checkpoint-to-checkpoint
 * (or last-checkpoint-to-end-of-body) span, in the same order as
 * `checkpointOffsets`. See `STAGE_CHECKPOINT_HEADER_SIZE`/`BYTES_PER_FRAME`
 * for the model this is based on. Identical in shape to th07's function of
 * the same name (games/th07.ts), duplicated rather than shared since the two
 * games' constants and empirical basis are independent.
 */
function perCheckpointFrameCounts(decodeData: Uint8Array, checkpointOffsets: number[]): number[] {
  return checkpointOffsets.map((offset, i) => {
    const start = offset + STAGE_CHECKPOINT_HEADER_SIZE;
    const end = i + 1 < checkpointOffsets.length ? checkpointOffsets[i + 1]! : decodeData.length;
    return Math.max(0, Math.floor((end - start) / BYTES_PER_FRAME));
  });
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
  // threplay (and this package, until this was investigated for frameCount
  // support) labeled this field "Time", but it isn't elapsed time: the
  // values observed in test-fixtures/th08/{th8_03,th8_06}.rpy are small,
  // monotonically non-decreasing per-stage integers (0,0,1,2,3,4), which
  // matches `pointItemExteds` (a point-item-extend counter) in
  // GensokyoClub/th08's decompilation of StageReplayData
  // (src/ReplayManager.hpp) at this same offset — extends only happen a
  // handful of times across a full playthrough. Renamed here accordingly.
  const pointItemExtends = readBufferedUint32LE(decodeData, offset + 0xc);
  split.additional = route ? { pointItems, pointItemExtends, route } : { pointItems, pointItemExtends };
  split.graze = readBufferedUint32LE(decodeData, offset + 0x8);
  split.piv = readBufferedUint32LE(decodeData, offset + 0x14);
  split.power = String(decodeData[offset + 0x1c] ?? 0);
  split.lives = resourceCount(decodeData[offset + 0x1d] ?? 0);
  split.bombs = resourceCount(decodeData[offset + 0x1e] ?? 0);
  return split;
}
