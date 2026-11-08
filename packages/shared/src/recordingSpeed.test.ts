import { describe, expect, it } from "vitest";
import {
  COMPLETION_ESTIMATE,
  estimateRecordingCompletionSeconds,
  normalizeRecordingSpeed,
  recordingSpeedOf,
  recordingWallClockSeconds,
  recordingTargetHz,
} from "./recordingSpeed.js";

describe("normalizeRecordingSpeed / recordingSpeedOf", () => {
  it("1〜4はそのまま、それ以外は等倍", () => {
    for (const speed of [1, 2, 3, 4]) {
      expect(normalizeRecordingSpeed(speed)).toBe(speed);
    }
    for (const bad of [0, 5, 1.5, -2, "2", null, undefined]) {
      expect(normalizeRecordingSpeed(bad)).toBe(1);
    }
  });

  it("recordingSpeedを持たない旧ジョブは等倍", () => {
    expect(recordingSpeedOf(undefined)).toBe(1);
    expect(recordingSpeedOf({})).toBe(1);
    expect(recordingSpeedOf({ recordingSpeed: 3 })).toBe(3);
  });
});

describe("recordingTargetHz", () => {
  it("60×倍率", () => {
    expect(recordingTargetHz(2)).toBe(120);
    expect(recordingTargetHz(4)).toBe(240);
    expect(recordingTargetHz(1 / 2)).toBe(30);
    expect(recordingTargetHz(1 / 3)).toBe(20);
  });
});

describe("recordingWallClockSeconds / estimateRecordingCompletionSeconds", () => {
  it("等倍は尺そのまま、倍速は約1/N", () => {
    expect(recordingWallClockSeconds(1200, 1)).toBe(1200);
    expect(recordingWallClockSeconds(1200, 2)).toBeCloseTo(630);
    expect(recordingWallClockSeconds(1200, 4)).toBeCloseTo(315);
  });

  it("完了時間は固定分+録画+変換で、速いほど短い", () => {
    const one = estimateRecordingCompletionSeconds(1200, 1, true);
    const two = estimateRecordingCompletionSeconds(1200, 2, true);
    expect(one).toBeCloseTo(
      COMPLETION_ESTIMATE.gpu.overheadSeconds + 1200 + 1200 * COMPLETION_ESTIMATE.gpu.convertRatio,
    );
    expect(two).toBeLessThan(one);
  });

  it("CPU系は変換が遅いぶん長い", () => {
    expect(estimateRecordingCompletionSeconds(1200, 1, false)).toBeGreaterThan(
      estimateRecordingCompletionSeconds(1200, 1, true),
    );
  });
});

describe("低速録画（Issue #316）", () => {
  it("ジョブレコードの低速の値を正規化で失わない", () => {
    expect(normalizeRecordingSpeed(1 / 2)).toBe(1 / 2);
    expect(normalizeRecordingSpeed(1 / 3)).toBe(1 / 3);
  });

  it("実時間の見積もりが実測(reports/91)に合う", () => {
    expect(recordingWallClockSeconds(100, 1 / 2)).toBeCloseTo(206);
    expect(recordingWallClockSeconds(100, 1 / 3)).toBeCloseTo(309);
  });
});
