import { describe, expect, it } from "vitest";
import { SUPPORTED_GAME_IDS } from "./games.js";
import {
  defaultSlowMotionFor,
  isSlowMotionRecording,
  NATIVE_FRAME_RATE_HZ,
  recordingWallClockScale,
  SLOW_MOTION_CAPABILITY,
  SLOW_MOTION_DEFAULT_GAME_IDS,
  SLOW_MOTION_TARGET_HZ,
  SLOW_MOTION_TIME_SCALE,
} from "./slowMotion.js";
import { WORKER_CAPABILITIES } from "./worker.js";

describe("低速録画の定数", () => {
  it("実時間の倍率は目標fpsから導出される(2つの数字が食い違わないように)", () => {
    expect(SLOW_MOTION_TIME_SCALE).toBe(NATIVE_FRAME_RATE_HZ / SLOW_MOTION_TARGET_HZ);
    expect(SLOW_MOTION_TIME_SCALE).toBe(2);
  });

  it("要求する能力は WORKER_CAPABILITIES に実在する値である", () => {
    expect(WORKER_CAPABILITIES).toContain(SLOW_MOTION_CAPABILITY);
  });

  it("既定でオンにするタイトルは録画対応タイトルの中から選ぶ", () => {
    for (const game of SLOW_MOTION_DEFAULT_GAME_IDS) {
      expect(SUPPORTED_GAME_IDS).toContain(game);
    }
  });
});

describe("defaultSlowMotionFor", () => {
  it("自宅ワーカーが使えるなら th20 は既定オン", () => {
    expect(defaultSlowMotionFor("th20", true)).toBe(true);
  });

  it("他タイトルは自宅ワーカーが使えても既定オフ(倍の時間をかける既定にしない)", () => {
    expect(defaultSlowMotionFor("th11", true)).toBe(false);
    expect(defaultSlowMotionFor("th07", true)).toBe(false);
  });

  it("自宅ワーカーが使えなければ th20 でも常にオフ(そもそも選べない)", () => {
    expect(defaultSlowMotionFor("th20", false)).toBe(false);
  });

  it("タイトル未確定(解析前)ならオフ", () => {
    expect(defaultSlowMotionFor(null, true)).toBe(false);
  });
});

describe("recordingWallClockScale", () => {
  it("等倍録画は1倍", () => {
    expect(recordingWallClockScale(false)).toBe(1);
  });

  it("低速録画は SLOW_MOTION_TIME_SCALE 倍", () => {
    expect(recordingWallClockScale(true)).toBe(SLOW_MOTION_TIME_SCALE);
  });
});

describe("isSlowMotionRecording", () => {
  it("希望していなければ、どのワーカーでも常に false", () => {
    expect(isSlowMotionRecording({ slowMotion: false }, "home")).toBe(false);
    expect(isSlowMotionRecording({ slowMotion: false }, null)).toBe(false);
  });

  it("自宅ワーカーが引き受けたなら true", () => {
    expect(isSlowMotionRecording({ slowMotion: true }, "home")).toBe(true);
  });

  it("EC2へフォールバックしたら false(EC2では等倍で録画する)", () => {
    expect(isSlowMotionRecording({ slowMotion: true }, "ec2")).toBe(false);
  });

  it("割り当て未確定の間は true(残り時間の見積もりが割り当て確定の瞬間に飛ばないように)", () => {
    expect(isSlowMotionRecording({ slowMotion: true }, null)).toBe(true);
  });
});
