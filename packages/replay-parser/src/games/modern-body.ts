import { ReplayCorruptError } from "../errors.js";
import { decompress, readBufferedUint32LE, xorBlockDecode } from "../lzss.js";

const MODERN_HEADER_SIZE = 36;

/**
 * The "body" decoding pipeline shared from th10 (東方風神録, MoF) onward.
 * After stripping the header, this runs two passes of XOR block decoding
 * followed by LZSS decompression (consolidating the processing common to the
 * start of each Read_tNNr in threplay).
 *
 * `headerSize` defaults to 36 bytes, the layout shared by th10-th18
 * (`magic_ver`/`version`/`unused_1`/`userdata_offset` = 4 bytes each,
 * `unused_2` = 12 bytes, then the `comp_size`/`size` fields read below,
 * immediately followed by the compressed body). th20 is the one exception
 * (a wider 24-byte `unused_2`, for a 48-byte header total) — see the
 * `TH20_HEADER_SIZE` comment in `games/th20.ts`. Whatever the total size,
 * `comp_size`/`size` always sit immediately before the compressed body, i.e.
 * at `headerSize - 8`/`headerSize - 4`, which is what let this function stay
 * a single parametrized implementation instead of a th20-specific copy.
 */
/**
 * Offset within the decompressed body of `ParsedReplay.recordedAt` (a raw
 * Unix epoch timestamp, seconds), for titles whose body header opens with
 * `name` (fixed-width SJIS player name, null-padded) immediately followed
 * by `timestamp`. This is a *second*, independent recording of the same
 * moment `date` (read from the USER section by `readModernUserdata`)
 * represents — but as a raw epoch value it always carries the full
 * 4-digit year and (unlike `date`'s minute resolution for these titles)
 * second-level precision, at the cost of depending on the recording PC's
 * system clock/timezone being correct, the same caveat `date` already has.
 *
 * Confirmed against n-rook/thscoreboard's per-title kaitai struct
 * definitions (`replays/kaitai_parsers/th1{0..8}.py`, class `Header`),
 * which define this field explicitly and are thscoreboard's own canonical
 * timestamp source for these titles (used in preference to the `date`
 * string). Field width differs there: `timestamp` is `u4le` (32-bit) for
 * th10 only, `u8le` (64-bit) for th11 onward — but every real replay's
 * value fits in the low 32 bits (the field only overflows past year
 * ~2106), so this package reads just the low `u32le` via
 * `readBufferedUint32LE` for every title, without needing 64-bit
 * arithmetic. `name` itself is 12 bytes for th10-th16 (`_12BYTE_NAME`
 * below) but 16 bytes for th17/th18 (`_16BYTE_NAME`), which shifts this
 * offset accordingly.
 *
 * Cross-validated against real replays (`test-fixtures/` plus fresh Silent
 * Selene downloads, see `.agents/skills/silent-selene/`) for th10, th11,
 * th12, th13, th14, th15, th16, th17, th18: converting the raw value to
 * JST (UTC+9, ZUN's own locale) matches `date` down to the minute in all
 * but 2 of ~15 samples checked, where it differs by exactly 1 hour —
 * consistent with the recording PC's own clock/timezone being slightly
 * off rather than a decoding error (the same ambiguity `date` is already
 * subject to, just usually invisible since `date` has no seconds to show
 * the drift).
 *
 * th20 is excluded (`ParsedReplay.recordedAt` is `null` there): its body
 * header has an entirely different layout (see `TH20_HEADER_SIZE` /
 * `SHOT_OFFSET` in `games/th20.ts`), and this offset has not been
 * reverse-engineered for it.
 */
export const RECORDED_AT_OFFSET_12BYTE_NAME = 0x0c;
/** See `RECORDED_AT_OFFSET_12BYTE_NAME` — th17/th18 only, whose `name` field is 16 bytes instead of 12. */
export const RECORDED_AT_OFFSET_16BYTE_NAME = 0x10;

export function decodeModernBody(
  original: Uint8Array,
  pass1: { blockSize: number; base: number; add: number },
  pass2: { blockSize: number; base: number; add: number },
  headerSize: number = MODERN_HEADER_SIZE,
): Uint8Array {
  if (original.length < headerSize + 4 + 4) {
    throw new ReplayCorruptError("file too short for modern-era header");
  }
  const length = readBufferedUint32LE(original, headerSize - 8);
  const dlength = readBufferedUint32LE(original, headerSize - 4);
  const workBuffer = original.slice(headerSize);
  xorBlockDecode(workBuffer, length, pass1.blockSize, pass1.base, pass1.add);
  xorBlockDecode(workBuffer, length, pass2.blockSize, pass2.base, pass2.add);
  return decompress(workBuffer, length, dlength);
}
