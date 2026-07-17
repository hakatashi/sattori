import { ReplayCorruptError } from "../errors.js";
import { decompress, readBufferedUint32LE, xorBlockDecode } from "../lzss.js";

const MODERN_HEADER_SIZE = 36;

/**
 * th10 (風神録) 以降で共通の「本文」復号パイプライン。
 * ヘッダ36バイトを除去したのち、2段階のXORブロック復号 → LZSS展開を行う。
 * （threplay の各 Read_tNNr 冒頭で共通に行われている処理を集約）。
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
