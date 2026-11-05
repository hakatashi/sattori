import { describe, expect, it } from "vitest";
import { SUPPORTED_GAME_IDS } from "./games.js";
import type { GameId } from "./games.js";
import {
  fallbackRecordingSpeedFor,
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

describe("fallbackRecordingSpeedFor（Issue #289・#316）", () => {
  it("CPU系タイトルの倍速録画は等倍へ落とす", () => {
    for (const speed of [2, 3, 4]) {
      expect(fallbackRecordingSpeedFor({ game: "th07", options: { recordingSpeed: speed } })).toBe(1);
    }
  });

  it("CPU系タイトルの等倍録画は落とさない", () => {
    expect(fallbackRecordingSpeedFor({ game: "th07", options: { recordingSpeed: 1 } })).toBeNull();
    expect(fallbackRecordingSpeedFor({ game: "th07" })).toBeNull();
  });

  it("th15・th20は等倍でも倍速でも1/2倍速へ落とす", () => {
    for (const game of ["th15", "th20"] as const) {
      for (const speed of [1, 2, 3, 4]) {
        expect(fallbackRecordingSpeedFor({ game, options: { recordingSpeed: speed } })).toBe(1 / 2);
      }
    }
  });

  it("th15のExtraだけ1/3倍速へ落とす", () => {
    const extra = { difficulty: "Extra" };
    expect(fallbackRecordingSpeedFor({ game: "th15", replayInfo: extra })).toBe(1 / 3);
    expect(fallbackRecordingSpeedFor({ game: "th20", replayInfo: extra })).toBe(1 / 2);
    expect(fallbackRecordingSpeedFor({ game: "th15", replayInfo: { difficulty: "Lunatic" } })).toBe(1 / 2);
    expect(fallbackRecordingSpeedFor({ game: "th15", replayInfo: null })).toBe(1 / 2);
  });

  it("th06ncは落とす先が無い", () => {
    for (const speed of [1, 2]) {
      expect(fallbackRecordingSpeedFor({ game: "th06nc", options: { recordingSpeed: speed } })).toBeNull();
    }
  });

  it("低速へ落としたジョブはもう落とさない", () => {
    expect(fallbackRecordingSpeedFor({ game: "th20", options: { recordingSpeed: 1 / 2 } })).toBeNull();
  });
});

describe("requiresGpuRecording（低速録画、Issue #316）", () => {
  it("低速録画はGPU系インスタンスを使わない", () => {
    expect(requiresGpuRecording({ game: "th15", options: { recordingSpeed: 1 / 3 } })).toBe(false);
    expect(requiresGpuRecording({ game: "th20", options: { recordingSpeed: 1 / 2 } })).toBe(false);
  });

  it("等倍のth15・th20はGPU系インスタンスを使う", () => {
    expect(requiresGpuRecording({ game: "th15", options: { recordingSpeed: 1 } })).toBe(true);
    expect(requiresGpuRecording({ game: "th20" })).toBe(true);
  });
});
