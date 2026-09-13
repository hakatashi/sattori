import { describe, expect, it } from "vitest";
import { GPU_RECORDING_GAME_IDS } from "./gpuRecording.js";
import {
  HIGH_RESOLUTION_RECORDING_SUPPORTED_GAME_IDS,
  supportsHighResolutionRecording,
} from "./highResolutionRecording.js";

describe("HIGH_RESOLUTION_RECORDING_SUPPORTED_GAME_IDS", () => {
  it("GPU描画必須タイトルの部分集合である(解像度切り替えはGPU描画経路にのみ実装済み)", () => {
    for (const game of HIGH_RESOLUTION_RECORDING_SUPPORTED_GAME_IDS) {
      expect(GPU_RECORDING_GAME_IDS).toContain(game);
    }
  });
});

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
