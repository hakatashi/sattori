import type { ParsedReplay } from "@sattori/touhou-replay-parser";
import { describe, expect, it } from "vitest";
import { fromParsedReplay } from "./replay.js";

function baseParsedReplay(overrides: Partial<ParsedReplay> = {}): ParsedReplay {
  return {
    game: "th07",
    gameTitle: "東方妖々夢 ～ Perfect Cherry Blossom",
    formatVersion: 5,
    player: "koyi",
    date: "01/18",
    character: "MarisaA",
    difficulty: "Extra",
    stage: null,
    score: 303766040,
    cleared: true,
    splits: [],
    frameCount: 50812,
    ...overrides,
  };
}

describe("fromParsedReplay", () => {
  it("maps the fields Sattori needs and drops the rest (e.g. splits, formatVersion)", () => {
    const info = fromParsedReplay(baseParsedReplay());
    expect(info).toEqual({
      game: "th07",
      player: "koyi",
      date: "01/18",
      character: "MarisaA",
      difficulty: "Extra",
      stage: null,
      score: 303766040,
      cleared: true,
      estimatedDurationSeconds: 847,
    });
  });

  it("falls back to an empty string when player is null", () => {
    const info = fromParsedReplay(baseParsedReplay({ player: null }));
    expect(info.player).toBe("");
  });

  it("returns null estimatedDurationSeconds when frameCount is unavailable", () => {
    const info = fromParsedReplay(baseParsedReplay({ frameCount: null }));
    expect(info.estimatedDurationSeconds).toBeNull();
  });
});
