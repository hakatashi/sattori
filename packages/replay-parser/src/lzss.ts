import { ReplayCorruptError } from "./errors.js";

/**
 * 展開後サイズの妥当性チェック用上限（64MiB）。
 * ヘッダの length/dlength フィールドは信頼できない外部入力なので、
 * ここでガードしないと不正な巨大値で無制限に確保しようとしてしまう。
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
  // https://github.com/Fluorohydride/thprac/blob/master/common.cpp (common.cpp の get_bit を移植)
  let result = 0;
  for (let i = 0; i < bitLength; i++) {
    result <<= 1;
    if (cursor.pointer >= length) {
      // 元実装は buffer 境界を超えて読み進めることがあるが、直後に
      // 呼び出し側で `pointer >= length` を確認して打ち切るため実害はない。
      // ここでは 0 埋めで安全側に倒す。
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
 * threp (https://github.com/Fluorohydride/threp/blob/master/common.cpp) の
 * decompress() を移植した LZSS 系展開（13bit辞書 / 4bit長）。
 * `length` は入力（圧縮済み）バイト数、`outLength` は展開後の期待バイト数。
 */
export function decompress(buffer: Uint8Array, length: number, outLength: number): Uint8Array {
  assertSaneAllocSize(outLength, "decompressed length");
  // length はヘッダから読んだ信頼できない値。バッファの実サイズを超える値は
  // 破損データであり、そのまま使うとループが実際のデータ量に対して不当に
  // 長時間回り続ける（DoSになり得る）ため、物理的に取り得ない値はここで丸める。
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
        // index は不正入力なら負値/範囲外になり得るが、TypedArray の範囲外
        // read/write は例外を投げず undefined→0 に丸められるので安全。
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
 * threp の decode()（ブロック単位の XOR 難読化解除）を移植。
 * `buffer` の先頭 `length` バイトを in-place で書き換える。
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

/** 旧世代フォーマット（th06-09）で使われる単純な加算キー方式の復号。 */
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
