import { ByteReader } from "../byte-reader.js";
import { localizeCharacterName } from "../character-names.js";
import { ReplayCorruptError } from "../errors.js";
import { additiveKeyDecode, decompress, readBufferedUint32LE } from "../lzss.js";
import { jumpToUser } from "../userdata.js";
import { DATE_TOKENS_YMD, parseDateComponents } from "../date-format.js";
import { emptySplit, normalizeText, resourceCount, type ParsedReplay, type ReplayStageSplit } from "../types.js";
import { REPLAY_GAME_TITLES } from "../game-ids.js";

const CHARACTERS = [
  "Reimu",
  "Marisa",
  "Sakuya",
  "Youmu",
  "Reisen",
  "Cirno",
  "Lyrica",
  "Mystia",
  "Tewi",
  "Yuuka",
  "Aya",
  "Medicine",
  "Komachi",
  "Eiki",
  "Merlin",
  "Lunasa",
];

const HEADER_SIZE = 0xc0;

/**
 * Size of the fixed per-checkpoint header preceding each stage/match's raw
 * input log within the decompressed body. Not documented by threplay/threp
 * (neither parses this data). Reverse-engineered from
 * `test-fixtures/th09/*.rpy`: dumping the raw bytes right after each of the
 * 40 `scoreOffsets` checkpoints shows the same shape every time — 32 bytes of
 * fields (score, an unidentified 4-byte value, a 1-byte lives count matching
 * `split.lives`, a few more small fields, then zero padding) followed by a
 * clean, repeating 2-byte-per-record pattern that only changes value when the
 * held input changes (e.g. `01 00` repeated for many records, then `11 00`
 * for many more) — exactly the shape of a fixed-width per-frame input log.
 *
 * `scoreOffsets[0..9]` covers the self player (index 9 doubling as a
 * story-vs-VS mode flag: 0 in story mode, non-zero in VS/Match mode) and
 * `[10..19]` covers the opponent, immediately following the self player's
 * data in the decompressed body — i.e. the self player's last stage/match log
 * runs uninterrupted until the first populated slot of `[10..19]` (`th9_07`'s
 * 9-stage story mode ends its stage-9 log exactly at `scoreOffsets[10]`; `th9_05`'s
 * single VS match ends its log exactly at `scoreOffsets[19]`, the only
 * populated opponent slot). `[20..29]` and `[30..39]` mirror the same
 * checkpoint spacing (confirmed by an exact constant offset from `[0..9]`/
 * `[10..19]`) but are not used here — this package does not need to know what
 * they represent to compute `frameCount` from the self player's own log.
 */
const STAGE_CHECKPOINT_HEADER_SIZE = 32;
/**
 * See `STAGE_CHECKPOINT_HEADER_SIZE`. Determined the same way as th07/th08's
 * constant of the same name: `(gap - STAGE_CHECKPOINT_HEADER_SIZE) / 2` comes
 * out to an exact integer for every checkpoint-to-checkpoint gap in every
 * checked-in `test-fixtures/th09/*.rpy` fixture.
 *
 * Cross-validated against real recorded per-stage durations of
 * `th9_07.rpy` (`touhou-recorder`-style manual in-game timer readout, not
 * checked in as a report): the computed frame count for every one of its 9
 * stages consistently overshoots the timer-based lower bound (see
 * `ParsedReplay.frameCount`'s "may be larger" caveat — the timer excludes
 * surrounding dialogue/menu frames) by 4.5-9.6 seconds for the 7 stages with
 * a single retry, ~6.1s for the one 2-retry stage, and ~16.7s for the one
 * 4-retry stage — i.e. the overshoot scales with retry count, exactly as
 * expected from each retry adding its own pre-battle overhead, rather than
 * being random noise.
 */
const BYTES_PER_FRAME = 2;

/**
 * T9RP (東方花映塚, PoFV) decoder. Ported from Read_T9RP in threplay.
 * Since this title is VS-battle only, the player's character does not appear
 * as the top-level `character` but as "PlayerChar vs OpponentChar" in each
 * split's `additional` (in story mode, the leading character from the splits
 * is also duplicated into the top-level `character`).
 */
export function parseTh09(original: Uint8Array): ParsedReplay {
  const reader = new ByteReader(original);
  jumpToUser(reader, 12);

  reader.readUint32LE();
  reader.skip(17);
  const name = reader.readAnsiString();
  reader.skip(11);
  const date = reader.readAnsiString();
  reader.skip(8);
  const difficulty = reader.readAnsiString();
  reader.skip(8);
  const stage = reader.readAnsiString();

  if (original.length < HEADER_SIZE + 0x20 + 40 * 4) {
    throw new ReplayCorruptError("file too short for T9RP header");
  }
  const buffer = original.slice();
  const length = readBufferedUint32LE(buffer, 0x0c);
  additiveKeyDecode(buffer, 24, buffer[0x15]!, 7);
  const dlength = readBufferedUint32LE(buffer, 0x1c);

  const scoreOffsets: number[] = [];
  let maxStage = 0;
  for (let i = 0; i < 40; i++) {
    const offset = readBufferedUint32LE(buffer, 0x20 + 4 * i);
    scoreOffsets.push(offset);
    if (i < 10 && offset !== 0) maxStage = i;
  }

  const shifted = buffer.slice(HEADER_SIZE);
  const decodeData = decompress(shifted, length - HEADER_SIZE, dlength);

  const splits: ReplayStageSplit[] = [];
  let character: string | null = null;

  // The self player's log runs uninterrupted until the opponent's log
  // begins; the first populated slot of scoreOffsets[10..19] marks that
  // boundary regardless of story vs VS mode (see STAGE_CHECKPOINT_HEADER_SIZE).
  const opponentLogStart = scoreOffsets.slice(10, 20).find((v) => v !== 0);
  const selfLogEnd = opponentLogStart !== undefined ? opponentLogStart - HEADER_SIZE : decodeData.length;

  if (scoreOffsets[9] === 0) {
    // Story mode: self and opponent characters are recorded per stage.
    const checkpoints: { offset: number; stage: number }[] = [];
    for (let i = 0; i <= maxStage; i++) {
      const raw = scoreOffsets[i];
      if (!raw) continue;
      checkpoints.push({ offset: raw - HEADER_SIZE, stage: i + 1 });
    }
    const stageFrameCounts = perCheckpointFrameCounts(
      checkpoints.map((c) => c.offset),
      selfLogEnd,
    );
    checkpoints.forEach(({ offset, stage: stageNumber }, i) => {
      const offsetP2 = scoreOffsets[10 + (stageNumber - 1)]! - HEADER_SIZE;
      const split = emptySplit();
      split.stage = stageNumber;
      split.score = readBufferedUint32LE(decodeData, offset) * 10;
      split.lives = resourceCount(decodeData[offset + 0x8] ?? 0);
      const selfChar = CHARACTERS[decodeData[offset + 0x6]!] ?? "?";
      const opponentChar = CHARACTERS[decodeData[offsetP2 + 0x6]!] ?? "?";
      split.additional = { self: selfChar, opponent: opponentChar };
      split.frameCount = stageFrameCounts[i]!;
      if (i === 0) character = selfChar;
      splits.push(split);
    });
  } else {
    // VS mode: only one entry.
    const offset1 = scoreOffsets[9]! - HEADER_SIZE;
    const offset2 = scoreOffsets[19]! - HEADER_SIZE;
    const selfChar = CHARACTERS[decodeData[offset1 + 0x6]!] ?? "?";
    const opponentChar = CHARACTERS[decodeData[offset2 + 0x6]!] ?? "?";
    const split = emptySplit();
    split.additional = { self: selfChar, opponent: opponentChar };
    split.frameCount = perCheckpointFrameCounts([offset1], selfLogEnd)[0]!;
    character = selfChar;
    splits.push(split);
  }

  const { ja: characterNameJa, en: characterNameEn } = localizeCharacterName("th09", character);
  const frameCount = splits.reduce((sum, split) => (split.frameCount === null ? sum : sum + split.frameCount), 0);

  return {
    game: "th09",
    gameTitle: REPLAY_GAME_TITLES.th09,
    formatVersion: null,
    player: normalizeText(name),
    date: normalizeText(date),
    parsedDate: parseDateComponents(normalizeText(date), DATE_TOKENS_YMD),
    recordedAt: null,
    character,
    characterNameJa,
    characterNameEn,
    difficulty: normalizeText(difficulty),
    stage: normalizeText(stage),
    score: null,
    cleared: null,
    loadout: null,
    splits,
    frameCount: splits.length === 0 ? null : frameCount,
  };
}

/**
 * Returns the per-frame input log length for each checkpoint-to-checkpoint
 * span, in the same order as `checkpointOffsets`. `endOffset` terminates the
 * last checkpoint's span (the self player's log doesn't run to the end of
 * `decodeData` — the opponent's own log follows it; see
 * `STAGE_CHECKPOINT_HEADER_SIZE`). Identical in shape to th07/th08's function
 * of the same name, duplicated rather than shared since the three games'
 * constants and empirical basis are independent.
 */
function perCheckpointFrameCounts(checkpointOffsets: number[], endOffset: number): number[] {
  return checkpointOffsets.map((offset, i) => {
    const start = offset + STAGE_CHECKPOINT_HEADER_SIZE;
    const end = i + 1 < checkpointOffsets.length ? checkpointOffsets[i + 1]! : endOffset;
    return Math.max(0, Math.floor((end - start) / BYTES_PER_FRAME));
  });
}
