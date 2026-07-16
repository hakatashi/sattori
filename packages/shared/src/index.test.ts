import { describe, expect, it } from "vitest";
import { isSupportedGame, isTerminalStatus, DEFAULT_RECORDING_OPTIONS } from "./index.js";

describe("shared", () => {
  it("フェーズ1では th07 のみ録画対応", () => {
    expect(isSupportedGame("th07")).toBe(true);
    expect(isSupportedGame("th08")).toBe(false);
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
