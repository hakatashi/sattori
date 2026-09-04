import { ByteReader } from "../byte-reader.js";
import { ReplayCorruptError } from "../errors.js";
import { decompress, readBufferedUint32LE, xorBlockDecode } from "../lzss.js";
import { jumpToUser, parseScoreWithTrailingZero } from "../userdata.js";
import { DATE_TOKENS_YMD_HM, parseDateComponents } from "../date-format.js";
import { emptySplit, normalizeText, resourceCount, type ParsedReplay, type ReplayStageSplit } from "../types.js";
import { REPLAY_GAME_TITLES } from "../game-ids.js";

const HEADER_SIZE = 36;

/**
 * 128r (妖精大戦争 ～ 東方三月精, GFW) decoder. Ported from Read_128r in threplay.
 * The USER section is read using the old-generation method, but the per-stage
 * breakdown is a hybrid format using the same XOR block decoding + LZSS
 * decompression pipeline as th10 onward.
 *
 * The decompressed body's header/per-stage layout (offsets for `timestamp`,
 * `cleared`, and the per-stage `stage`/`frames`/`graze` fields below) was
 * cross-checked against two independent reverse-engineerings that agree
 * exactly on field names and offsets: n-rook/thscoreboard's
 * `replays/kaitai_parsers/th128.py` and puresign-tokyo/l-uploader's
 * `backend/src/parsers/threp-ksy/th128.ksy` (see "Related work" in the
 * package README). Neither project actually reads `cleared`/`stage`/`frames`/
 * `graze` into their own output, so this package's use of them (see below)
 * is its own reverse engineering, verified against the 4 checked-in
 * `test-fixtures/th128/*.rpy` replays and real in-game observation of each
 * (reached stage, pass/fail, stage sequence) — not just the byte offsets.
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

  // Bit 0x10 of the header's `cleared` field (offset 0x68) is set iff the
  // run ended in a clear (Player Wins); the low bits otherwise duplicate the
  // last stage's raw `stage` id (see below), which this package already
  // exposes directly, so only the bit is used. Confirmed against all 4
  // checked-in fixtures cross-referenced with real in-game clear/game-over
  // observation: values 3/4/11 (routes ending in game over) vs. 19 = 3 |
  // 0x10 (the one fixture that reached "B1 All" and actually cleared).
  const cleared = (readBufferedUint32LE(decodedata, 0x68) & 0x10) !== 0;

  const splits: ReplayStageSplit[] = [];
  let stageOffset = 0x70;
  const stageCount = decodedata[0x58] ?? 0;
  let frameCount = 0;
  for (let i = 0; i < stageCount; i++) {
    const split = emptySplit();
    // Raw in-game stage id (th128's routing branches — Route A/A2/B/B2/C/C2 —
    // mean this is not a contiguous 1/2/3 run counter; e.g. a Route A run
    // that branches to A2 after stage 1 records ids 1 then 4, confirmed
    // against real in-game stage names for all 4 checked-in fixtures).
    split.stage = readUint16LE(decodedata, stageOffset);
    split.score = readBufferedUint32LE(decodedata, stageOffset + 0xc) * 10;
    split.power = String(readBufferedUint32LE(decodedata, stageOffset + 0x10) + 1);
    // th128 records lives/bombs as a percentage gauge rather than a count
    // (ReplayResourceCount.count holds the percentage, maxPieces is fixed at 100).
    split.lives = resourceCount(Math.trunc(readBufferedUint32LE(decodedata, stageOffset + 0x80) / 100), null, 100);
    split.bombs = resourceCount(Math.trunc(readBufferedUint32LE(decodedata, stageOffset + 0x84) / 100), null, 100);
    // Weaker-confidence field: named "graze" by both external kaitai
    // definitions (offset agreement only; neither project actually reads it),
    // and plausible in that GFW does have a real grazing mechanic (each
    // grazed bullet recovers 1% of the 氷力/ice-power gauge — see
    // wikiwiki.jp/thk's 妖精大戦争/基本戦略, "カスリ：1.00%/1弾" — it's just
    // folded into that gauge rather than shown as its own HUD counter, unlike
    // mainline titles). But unlike `stage`/`frameCount`/`cleared` above, the
    // actual per-stage values have not been cross-checked against a real
    // grazed-bullet count from recorded footage — only that they start at 0
    // and increase monotonically across the 4 checked-in fixtures.
    split.graze = readBufferedUint32LE(decodedata, stageOffset + 0x28);
    const freezeArea = readFloat32LE(decodedata, stageOffset + 0x88);
    split.additional = { freezeAreaPercent: Math.trunc(freezeArea) };
    const stageFrames = readBufferedUint32LE(decodedata, stageOffset + 0x4);
    split.frameCount = stageFrames;
    frameCount += stageFrames;
    splits.push(split);
    stageOffset += readBufferedUint32LE(decodedata, stageOffset + 0x8) + 0x90;
  }

  return {
    game: "th128",
    gameTitle: REPLAY_GAME_TITLES.th128,
    formatVersion: null,
    player: normalizeText(name),
    date: normalizeText(date),
    parsedDate: parseDateComponents(normalizeText(date), DATE_TOKENS_YMD_HM),
    // The decompressed body opens with a 12-byte name field immediately
    // followed by an 8-byte Unix epoch timestamp, the same shape as
    // th10-th18 (see RECORDED_AT_OFFSET_12BYTE_NAME in games/modern-body.ts)
    // — only the low 32 bits are read, following that same precedent (every
    // real replay's value fits, the field only overflows past year ~2106).
    // Cross-validated against `date` for all 4 checked-in fixtures: matches
    // down to the minute in JST (UTC+9) every time.
    recordedAt: readBufferedUint32LE(decodedata, 0xc),
    character: null,
    characterNameJa: null,
    characterNameEn: null,
    difficulty: normalizeText(difficulty),
    stage: normalizeText(stage),
    score,
    cleared,
    loadout: null,
    splits,
    frameCount,
  };
}

function readFloat32LE(buffer: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > buffer.length) {
    throw new ReplayCorruptError(`readFloat32LE out of range at ${offset}`);
  }
  return new DataView(buffer.buffer, buffer.byteOffset + offset, 4).getFloat32(0, true);
}

function readUint16LE(buffer: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 2 > buffer.length) {
    throw new ReplayCorruptError(`readUint16LE out of range at ${offset}`);
  }
  return buffer[offset]! | (buffer[offset + 1]! << 8);
}
