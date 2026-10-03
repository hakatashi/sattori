import { describe, expect, it } from "vitest";
import { SUPPORTED_GAME_IDS } from "./games.js";
import type { GameId } from "./games.js";
import { GPU_RECORDING_GAME_IDS, requiresGpuRecording } from "./gpuRecording.js";
import type { RecordingSpeed } from "./recordingSpeed.js";

describe("GPU_RECORDING_GAME_IDS", () => {
  it("録画対応タイトルの部分集合である", () => {
    for (const game of GPU_RECORDING_GAME_IDS) {
      expect(SUPPORTED_GAME_IDS).toContain(game);
    }
  });
});

describe("requiresGpuRecording", () => {
  const job = (game: GameId, recordingSpeed?: RecordingSpeed) => ({
    game,
    options: recordingSpeed === undefined ? {} : { recordingSpeed },
  });

  it("th06nc・th15(GPU描画必須)は等倍でも true", () => {
    expect(requiresGpuRecording(job("th06nc"))).toBe(true);
    expect(requiresGpuRecording(job("th15", 1))).toBe(true);
  });

  it("CPU系タイトルの等倍録画は false(recordingSpeed欠損の旧ジョブも等倍扱い)", () => {
    expect(requiresGpuRecording(job("th06"))).toBe(false);
    expect(requiresGpuRecording(job("th06c", 1))).toBe(false);
    expect(requiresGpuRecording(job("th07"))).toBe(false);
    expect(requiresGpuRecording(job("th20", 1))).toBe(false);
    expect(requiresGpuRecording({ game: "th10" })).toBe(false);
  });

  it("倍速録画(2倍速以上)は全タイトル true(Issue #288)", () => {
    for (const speed of [2, 3, 4] as const) {
      expect(requiresGpuRecording(job("th06", speed))).toBe(true);
      expect(requiresGpuRecording(job("th20", speed))).toBe(true);
    }
  });

  it("不正な録画速度は等倍扱い", () => {
    expect(requiresGpuRecording({ game: "th07", options: { recordingSpeed: 5 } })).toBe(false);
    expect(requiresGpuRecording({ game: "th07", options: { recordingSpeed: "2" } })).toBe(false);
  });
});
