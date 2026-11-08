import { describe, expect, it } from "vitest";
import {
  HIGH_RESOLUTION_RECORDING_SUPPORTED_GAME_IDS,
  supportsHighResolutionRecording,
} from "./highResolutionRecording.js";

describe("supportsHighResolutionRecording", () => {
  it("th06ncは true", () => {
    expect(supportsHighResolutionRecording("th06nc")).toBe(true);
  });

  it("他タイトルは false", () => {
    expect(supportsHighResolutionRecording("th06")).toBe(false);
    expect(supportsHighResolutionRecording("th06c")).toBe(false);
    expect(supportsHighResolutionRecording("th20")).toBe(false);
  });

  it("タイトル未確定(解析前)は false", () => {
    expect(supportsHighResolutionRecording(null)).toBe(false);
  });
});
