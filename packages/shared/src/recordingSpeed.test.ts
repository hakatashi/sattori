import { describe, expect, it } from "vitest";
import { SUPPORTED_GAME_IDS } from "./games.js";
import {
  COMPLETION_ESTIMATE,
  estimateRecordingCompletionSeconds,
  isFasterThanRecommended,
  normalizeRecordingSpeed,
  recommendedRecordingSpeed,
  recordingSpeedOf,
  recordingWallClockSeconds,
  speedupTargetHz,
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

describe("recommendedRecordingSpeed", () => {
  it("ユーザー指定のおすすめ値(Issue #288)", () => {
    expect(recommendedRecordingSpeed("th06")).toBe(2);
    expect(recommendedRecordingSpeed("th06c")).toBe(2);
    expect(recommendedRecordingSpeed("th07")).toBe(3);
    expect(recommendedRecordingSpeed("th08")).toBe(2);
    expect(recommendedRecordingSpeed("th09")).toBe(2);
    expect(recommendedRecordingSpeed("th10")).toBe(2);
    expect(recommendedRecordingSpeed("th11")).toBe(2);
    expect(recommendedRecordingSpeed("th12")).toBe(2);
    expect(recommendedRecordingSpeed("th128")).toBe(2);
    expect(recommendedRecordingSpeed("th15")).toBe(2);
    expect(recommendedRecordingSpeed("th20")).toBe(1);
  });

  it("th06ncは720pなら2倍速、1080pなら等倍", () => {
    expect(recommendedRecordingSpeed("th06nc")).toBe(2);
    expect(recommendedRecordingSpeed("th06nc", { th06ncHighResolution: false })).toBe(2);
    expect(recommendedRecordingSpeed("th06nc", { th06ncHighResolution: true })).toBe(1);
  });

  it("1080pオプションはth06nc以外には影響しない", () => {
    expect(recommendedRecordingSpeed("th07", { th06ncHighResolution: true })).toBe(3);
  });

  it("録画対応タイトルはすべて値を持つ", () => {
    for (const game of SUPPORTED_GAME_IDS) {
      expect([1, 2, 3, 4]).toContain(recommendedRecordingSpeed(game));
    }
  });
});

describe("isFasterThanRecommended", () => {
  it("おすすめより速いときだけ true", () => {
    expect(isFasterThanRecommended("th15", 2)).toBe(false);
    expect(isFasterThanRecommended("th15", 3)).toBe(true);
    expect(isFasterThanRecommended("th15", 1)).toBe(false);
    expect(isFasterThanRecommended("th07", 3)).toBe(false);
    expect(isFasterThanRecommended("th07", 4)).toBe(true);
    expect(isFasterThanRecommended("th20", 2)).toBe(true);
    expect(isFasterThanRecommended("th06nc", 2, { th06ncHighResolution: true })).toBe(true);
  });
});

describe("speedupTargetHz", () => {
  it("60×倍率", () => {
    expect(speedupTargetHz(2)).toBe(120);
    expect(speedupTargetHz(4)).toBe(240);
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
