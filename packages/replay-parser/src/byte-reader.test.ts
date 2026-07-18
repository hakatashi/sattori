import { describe, expect, it } from "vitest";
import { ByteReader, decodeAnsiText } from "./byte-reader.js";
import { ReplayCorruptError } from "./errors.js";

describe("ByteReader", () => {
  it("reads little-endian integers and advances the cursor", () => {
    const reader = new ByteReader(Uint8Array.from([0x01, 0x00, 0x02, 0x00, 0x00, 0x00]));
    expect(reader.readUint16LE()).toBe(1);
    expect(reader.readUint32LE()).toBe(2);
    expect(reader.pos).toBe(6);
  });

  it("throws ReplayCorruptError instead of returning undefined past the end", () => {
    const reader = new ByteReader(Uint8Array.from([0x01]));
    expect(() => reader.readUint32LE()).toThrow(ReplayCorruptError);
  });

  it("reads a CRLF-terminated ANSI string and leaves the cursor right after the terminator", () => {
    // Assumes a layout of "ABC\r\nXYZ". Verifies behavior equivalent to ReadStringANSI.
    const bytes = Uint8Array.from([...Buffer.from("ABC\r\nXYZ")]);
    const reader = new ByteReader(bytes);
    expect(reader.readAnsiString()).toBe("ABC");
    // The cursor sits right after \n, equivalent to file.Seek(-1, Current) in the original implementation.
    expect(reader.pos).toBe(5);
    expect(reader.readBytes(3)).toEqual(Uint8Array.from([...Buffer.from("XYZ")]));
  });

  it("handles an immediately-empty ANSI string (CRLF at the very start)", () => {
    const bytes = Uint8Array.from([...Buffer.from("\r\nXYZ")]);
    const reader = new ByteReader(bytes);
    expect(reader.readAnsiString()).toBe("");
  });
});

describe("decodeAnsiText", () => {
  it("decodes Shift_JIS bytes", () => {
    const bytes = Uint8Array.from([0x82, 0xa0, 0x82, 0xa2]); // "あい"
    expect(decodeAnsiText(bytes)).toBe("あい");
  });

  it("falls back to Latin1-style mapping for non-Shift_JIS bytes", () => {
    const bytes = Uint8Array.from([0xff, 0xfe]); // cannot be interpreted as valid Shift_JIS
    expect(decodeAnsiText(bytes)).toBe("ÿþ");
  });

  it("returns an empty string for empty input", () => {
    expect(decodeAnsiText(new Uint8Array(0))).toBe("");
  });
});
