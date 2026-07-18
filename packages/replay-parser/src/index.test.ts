import { describe, expect, it } from "vitest";
import { parseReplay } from "./index.js";

describe("parseReplay", () => {
  it("returns a too_short error for empty input", () => {
    const result = parseReplay(new Uint8Array(0));
    expect(result).toEqual({
      ok: false,
      error: { code: "too_short", message: expect.any(String) },
    });
  });

  it("returns a too_short error for input shorter than the magic header", () => {
    const result = parseReplay(Uint8Array.from([0x54, 0x37]));
    expect(result.ok).toBe(false);
  });

  it("returns an unknown_magic error for unrecognized headers", () => {
    const result = parseReplay(Uint8Array.from([0x00, 0x01, 0x02, 0x03, 0x04]));
    expect(result).toEqual({
      ok: false,
      error: { code: "unknown_magic", message: expect.any(String) },
    });
  });

  it("returns a corrupt error (never throws) for a truncated but recognizable T7RP file", () => {
    const magic = Uint8Array.from([0x54, 0x37, 0x52, 0x50]); // "T7RP"
    expect(() => parseReplay(magic)).not.toThrow();
    const result = parseReplay(magic);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("corrupt");
    }
  });
});
