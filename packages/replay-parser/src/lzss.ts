import { ReplayCorruptError } from "./errors.js";

/**
 * Upper bound (64MiB) used to sanity-check decompressed sizes.
 * The header's length/dlength fields are untrusted external input, so
 * without this guard an invalid huge value would attempt an unbounded allocation.
 */
const MAX_ALLOC_BYTES = 64 * 1024 * 1024;

export function assertSaneAllocSize(n: number, what: string): void {
  if (!Number.isFinite(n) || n < 0 || n > MAX_ALLOC_BYTES) {
    throw new ReplayCorruptError(`implausible ${what}: ${n}`);
  }
}

interface BitCursor {
  pointer: number;
  filter: number;
}

function getBit(buffer: Uint8Array, length: number, cursor: BitCursor, bitLength: number): number {
  // https://github.com/Fluorohydride/thprac/blob/master/common.cpp (ported from get_bit in common.cpp)
  let result = 0;
  for (let i = 0; i < bitLength; i++) {
    result <<= 1;
    if (cursor.pointer >= length) {
      // The original implementation can read past the buffer boundary, but this
      // is harmless because the caller immediately checks `pointer >= length`
      // and stops. Here we fail safe by zero-filling.
      cursor.filter >>= 1;
      if (cursor.filter === 0) {
        cursor.pointer++;
        cursor.filter = 0x80;
      }
      continue;
    }
    const current = buffer[cursor.pointer]!;
    if ((current & cursor.filter) !== 0) {
      result |= 1;
    }
    cursor.filter >>= 1;
    if (cursor.filter === 0) {
      cursor.pointer++;
      cursor.filter = 0x80;
    }
  }
  return result >>> 0;
}

/**
 * An LZSS-family decompressor (13-bit dictionary / 4-bit run length) ported
 * from decompress() in threp (https://github.com/Fluorohydride/threp/blob/master/common.cpp).
 * `length` is the input (compressed) byte count, `outLength` is the expected decompressed byte count.
 */
export function decompress(buffer: Uint8Array, length: number, outLength: number): Uint8Array {
  assertSaneAllocSize(outLength, "decompressed length");
  // length is an untrusted value read from the header. A value exceeding the
  // buffer's actual size indicates corrupt data, and using it as-is would let
  // the loop run for an unreasonably long time relative to the actual data
  // size (a potential DoS), so we clamp it here to a physically possible value.
  const boundedLength = Math.min(length, buffer.length);
  const decoded = new Uint8Array(outLength);
  const dict = new Uint8Array(0x2010);
  const cursor: BitCursor = { pointer: 0, filter: 0x80 };
  let dest = 0;

  while (cursor.pointer < boundedLength && dest < outLength) {
    const flag = getBit(buffer, boundedLength, cursor, 1);
    if (cursor.pointer >= boundedLength) break;

    if (flag !== 0) {
      const byte = getBit(buffer, boundedLength, cursor, 8);
      if (cursor.pointer >= boundedLength) break;
      decoded[dest] = byte;
      dict[dest & 0x1fff] = byte;
      dest++;
    } else {
      const indexBits = getBit(buffer, boundedLength, cursor, 13);
      if (cursor.pointer >= boundedLength) break;
      const index = indexBits - 1;
      let runLength = getBit(buffer, boundedLength, cursor, 4);
      if (cursor.pointer >= boundedLength) break;
      runLength += 3;
      for (let i = 0; i < runLength && dest < outLength; i++) {
        // index can be negative or out of range for invalid input, but
        // out-of-range TypedArray read/write does not throw and is
        // coerced to undefined -> 0, so this is safe.
        const value = dict[(index + i) & 0x1fff] ?? 0;
        dict[dest & 0x1fff] = value;
        decoded[dest] = value;
        dest++;
      }
    }
  }

  return decoded;
}

/**
 * Ported from threp's decode() (block-wise XOR deobfuscation).
 * Rewrites the first `length` bytes of `buffer` in place.
 */
export function xorBlockDecode(buffer: Uint8Array, length: number, blockSizeInit: number, baseInit: number, add: number): void {
  assertSaneAllocSize(length, "xorBlockDecode length");
  if (length > buffer.length) {
    throw new ReplayCorruptError(`xorBlockDecode: length ${length} exceeds buffer size ${buffer.length}`);
  }
  const tbuf = buffer.slice(0, length);
  let blockSize = blockSizeInit;
  let p = 0;
  let left = length;
  if (left % blockSize < Math.floor(blockSize / 4)) {
    left -= left % blockSize;
  }
  left -= length & 1;

  let base = baseInit & 0xff;
  while (left !== 0) {
    if (left < blockSize) blockSize = left;
    let tp1 = p + blockSize - 1;
    let tp2 = p + blockSize - 2;
    let half = (blockSize + (blockSize & 1)) >> 1;
    for (let i = 0; i < half; i++, p++) {
      if (tp1 >= 0 && tp1 < buffer.length && p < tbuf.length) {
        buffer[tp1] = (tbuf[p]! ^ base) & 0xff;
      }
      base = (base + add) & 0xff;
      tp1 -= 2;
    }
    half = blockSize >> 1;
    for (let i = 0; i < half; i++, p++) {
      if (tp2 >= 0 && tp2 < buffer.length && p < tbuf.length) {
        buffer[tp2] = (tbuf[p]! ^ base) & 0xff;
      }
      base = (base + add) & 0xff;
      tp2 -= 2;
    }
    left -= blockSize;
  }
}

/** Decodes the simple additive-key scheme used by the older format (th06-09). */
export function additiveKeyDecode(buffer: Uint8Array, start: number, initialKey: number, increment: number): void {
  let key = initialKey & 0xff;
  for (let i = start; i < buffer.length; i++) {
    buffer[i] = (buffer[i]! - key) & 0xff;
    key = (key + increment) & 0xff;
  }
}

export function readBufferedUint32LE(buffer: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > buffer.length) {
    throw new ReplayCorruptError(`readBufferedUint32LE out of range at ${offset} (length ${buffer.length})`);
  }
  return (
    (buffer[offset]! | (buffer[offset + 1]! << 8) | (buffer[offset + 2]! << 16) | (buffer[offset + 3]! << 24)) >>> 0
  );
}
