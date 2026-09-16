import { describe, expect, it } from "vitest";
import { SUPPORTED_GAME_IDS } from "./games.js";
import { GPU_RECORDING_GAME_IDS, requiresGpuRecording } from "./gpuRecording.js";

describe("GPU_RECORDING_GAME_IDS", () => {
  it("録画対応タイトルの部分集合である", () => {
    for (const game of GPU_RECORDING_GAME_IDS) {
      expect(SUPPORTED_GAME_IDS).toContain(game);
    }
  });
});

describe("requiresGpuRecording", () => {
  it("th06nc(GPU描画必須)は true", () => {
    expect(requiresGpuRecording("th06nc")).toBe(true);
  });

  it("th15(GPU描画必須)は true", () => {
    expect(requiresGpuRecording("th15")).toBe(true);
  });

  it("既存のCPU系タイトルは false", () => {
    expect(requiresGpuRecording("th06")).toBe(false);
    expect(requiresGpuRecording("th06c")).toBe(false);
    expect(requiresGpuRecording("th07")).toBe(false);
    expect(requiresGpuRecording("th20")).toBe(false);
  });
});
