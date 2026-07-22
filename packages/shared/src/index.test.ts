import { describe, expect, it } from "vitest";
import { isSupportedGame, isTerminalStatus, DEFAULT_RECORDING_OPTIONS } from "./index.js";

describe("shared", () => {
  it("th07・th08 が録画対応タイトル(Issue #13でth08を追加)", () => {
    expect(isSupportedGame("th07")).toBe(true);
    expect(isSupportedGame("th08")).toBe(true);
    // th11 はパーサー的には認識できるが録画には未対応(MOD移植が未着手)。
    expect(isSupportedGame("th11")).toBe(false);
  });

  it("終端状態を正しく判定する", () => {
    expect(isTerminalStatus("done")).toBe(true);
    expect(isTerminalStatus("failed")).toBe(true);
    expect(isTerminalStatus("recording")).toBe(false);
    expect(isTerminalStatus("queued")).toBe(false);
  });

  it("ウォーターマークはデフォルトON", () => {
    expect(DEFAULT_RECORDING_OPTIONS.watermark).toBe(true);
  });
});
