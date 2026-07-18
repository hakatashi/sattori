import { ReplayCorruptError } from "../errors.js";
import { decompress, readBufferedUint32LE, xorBlockDecode } from "../lzss.js";

const MODERN_HEADER_SIZE = 36;

/**
 * The "body" decoding pipeline shared from th10 (東方風神録, MoF) onward.
 * After stripping the 36-byte header, this runs two passes of XOR block
 * decoding followed by LZSS decompression (consolidating the processing
 * common to the start of each Read_tNNr in threplay).
 */
export function decodeModernBody(
  original: Uint8Array,
  pass1: { blockSize: number; base: number; add: number },
  pass2: { blockSize: number; base: number; add: number },
): Uint8Array {
  if (original.length < MODERN_HEADER_SIZE + 4 + 4) {
    throw new ReplayCorruptError("file too short for modern-era header");
  }
  const length = readBufferedUint32LE(original, 28);
  const dlength = readBufferedUint32LE(original, 32);
  const workBuffer = original.slice(MODERN_HEADER_SIZE);
  xorBlockDecode(workBuffer, length, pass1.blockSize, pass1.base, pass1.add);
  xorBlockDecode(workBuffer, length, pass2.blockSize, pass2.base, pass2.add);
  return decompress(workBuffer, length, dlength);
}
