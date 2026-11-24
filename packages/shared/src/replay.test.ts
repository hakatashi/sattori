import type { ParsedReplay } from "@sattori/touhou-replay-parser";
import { describe, expect, it } from "vitest";
import { fromParsedReplay, localizedCharacterName } from "./replay.js";

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
    loadout: null,
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
      finalStageScore: null,
      cleared: true,
      estimatedDurationSeconds: 847,
    });
  });

  it("takes finalStageScore from the last split as-is", () => {
    const split = (score: number) => ({ stage: 6, score }) as ParsedReplay["splits"][number];
    // 単位換算はreplay-parser側で済んでいる(th07のステージ記録も表示値で返る)。
    expect(fromParsedReplay(baseParsedReplay({ splits: [split(100), split(219169040)] })).finalStageScore).toBe(
      219169040,
    );
    // th06系のステージ記録は表示値(ヘッダと20点食い違う実例、th06 3731b273)。
    expect(
      fromParsedReplay(baseParsedReplay({ game: "th06", splits: [split(8868290), split(45621660)] })).finalStageScore,
    ).toBe(45621660);
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

describe("localizedCharacterName", () => {
  const info = fromParsedReplay(
    baseParsedReplay({ character: "MarisaA", characterNameJa: "魔符", characterNameEn: "Marisa A" }),
  );

  it("picks the localized name for the given language", () => {
    expect(localizedCharacterName(info, "ja")).toBe("魔符");
    expect(localizedCharacterName(info, "en")).toBe("Marisa A");
  });

  it("falls back to the raw character when no localized name is available", () => {
    const unknown = { ...info, characterNameJa: null, characterNameEn: null };
    expect(localizedCharacterName(unknown, "ja")).toBe("MarisaA");
  });

  it("returns null when the character itself is unknown", () => {
    const unknown = { ...info, character: null, characterNameJa: null, characterNameEn: null };
    expect(localizedCharacterName(unknown, "ja")).toBeNull();
  });
});
