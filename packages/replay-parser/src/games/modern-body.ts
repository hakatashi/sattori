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
