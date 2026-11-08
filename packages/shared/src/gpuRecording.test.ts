import { describe, expect, it } from "vitest";
import type { GameId } from "./games.js";
import { requiresGpuRecording } from "./gpuRecording.js";
import type { RecordingSpeed } from "./recordingSpeed.js";

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
