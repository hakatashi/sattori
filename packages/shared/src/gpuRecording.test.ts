import { describe, expect, it } from "vitest";
import { SUPPORTED_GAME_IDS } from "./games.js";
import type { GameId } from "./games.js";
import {
  canFallBackToNativeSpeed,
  GPU_RECORDING_GAME_IDS,
  requiresGpuRecording,
} from "./gpuRecording.js";
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
    expect(requiresGpuRecording(job("th11", 1))).toBe(false);
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

describe("canFallBackToNativeSpeed（Issue #289）", () => {
  it("CPU系タイトルの倍速録画は等倍へフォールバックできる", () => {
    for (const speed of [2, 3, 4] as const) {
      expect(canFallBackToNativeSpeed({ game: "th07", options: { recordingSpeed: speed } })).toBe(true);
    }
  });

  it("等倍録画(フォールバック済みを含む)はフォールバックしない", () => {
    expect(canFallBackToNativeSpeed({ game: "th07", options: { recordingSpeed: 1 } })).toBe(false);
    expect(canFallBackToNativeSpeed({ game: "th07" })).toBe(false);
  });

  it("GPU必須タイトルは倍速録画でもフォールバックしない(等倍でもGPUが要る)", () => {
    for (const game of GPU_RECORDING_GAME_IDS) {
      expect(canFallBackToNativeSpeed({ game, options: { recordingSpeed: 2 } })).toBe(false);
    }
  });
});
