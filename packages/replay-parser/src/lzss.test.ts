import { describe, expect, it } from "vitest";
import { additiveKeyDecode, readBufferedUint32LE } from "./lzss.js";
import { ReplayCorruptError } from "./errors.js";

describe("readBufferedUint32LE", () => {
  it("reads a little-endian uint32 at the given offset", () => {
    const buffer = Uint8Array.from([0x00, 0x78, 0x56, 0x34, 0x12]);
    expect(readBufferedUint32LE(buffer, 1)).toBe(0x12345678);
  });

  it("throws ReplayCorruptError when out of range", () => {
    const buffer = Uint8Array.from([0x01, 0x02]);
    expect(() => readBufferedUint32LE(buffer, 0)).toThrow(ReplayCorruptError);
  });
});

describe("additiveKeyDecode", () => {
  it("is the inverse of the th06/07-style additive-key XOR scramble", () => {
    // Encoding side: buffer[i] = (plain[i] + key) & 0xff; key += increment
    const plain = Uint8Array.from([10, 20, 30, 40]);
    const initialKey = 5;
    const increment = 7;
    let key = initialKey;
    const scrambled = plain.map((b) => {
      const out = (b + key) & 0xff;
      key = (key + increment) & 0xff;
      return out;
    });
    additiveKeyDecode(scrambled, 0, initialKey, increment);
    expect(Array.from(scrambled)).toEqual(Array.from(plain));
  });
});
