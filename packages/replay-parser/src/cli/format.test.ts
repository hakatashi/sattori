import { describe, expect, it } from "vitest";
import {
  formatCharacter,
  formatDuration,
  formatReplayJson,
  formatReplayText,
  formatScore,
  formatSplitDuration,
  formatSplitsTable,
} from "./format.js";
import type { ParsedReplay } from "../types.js";

describe("cli-format", () => {
  const sampleReplay: ParsedReplay = {
    game: "th07",
    gameTitle: "東方妖々夢 ～ Perfect Cherry Blossom.",
    formatVersion: 5,
    player: "Hakata",
    date: "05/26/11",
    parsedDate: { fullYear: null, shortYear: 11, month: 5, date: 26, hours: null, minutes: null, seconds: null },
    recordedAt: null,
    character: "ReimuA",
    characterNameJa: "霊符",
    characterNameEn: "Reimu A",
    difficulty: "Lunatic",
    stage: "Stage All Clear",
    score: 1234567890,
    cleared: true,
    frameCount: 51120,
    splits: [
      {
        stage: 1,
        score: 0,
        power: "1.00",
        piv: null,
        lives: { count: 2, pieces: null, maxPieces: null },
        bombs: { count: 3, pieces: null, maxPieces: null },
        graze: 120,
        frameCount: 7500,
        additional: null,
      },
      {
        stage: 2,
        score: 24500000,
        power: "4.00",
        piv: null,
        lives: { count: 2, pieces: null, maxPieces: null },
        bombs: { count: 2, pieces: 1, maxPieces: 3 },
        graze: 450,
        frameCount: 8100,
        additional: null,
      },
    ],
  };

  it("formatDuration formats frames correctly", () => {
    expect(formatDuration(null)).toBe("-");
    expect(formatDuration(1800)).toBe("30s (1,800 frames)");
    expect(formatDuration(51120)).toBe("14m 12s (51,120 frames)");
    expect(formatDuration(3600 * 60 + 65 * 60)).toBe("1h 01m 05s (219,900 frames)");
  });

  it("formatSplitDuration formats frames compactly", () => {
    expect(formatSplitDuration(null)).toBe("-");
    expect(formatSplitDuration(1800)).toBe("30s");
    expect(formatSplitDuration(7500)).toBe("2m 05s");
    expect(formatSplitDuration(3665 * 60)).toBe("1h 01m 05s");
  });

  it("formatScore formats number with commas", () => {
    expect(formatScore(null)).toBe("-");
    expect(formatScore(1234567890)).toBe("1,234,567,890");
  });

  it("formatCharacter localizes properly", () => {
    expect(formatCharacter(sampleReplay)).toBe("霊符 / Reimu A (ReimuA)");

    expect(
      formatCharacter({
        ...sampleReplay,
        character: "博麗　霊夢",
        characterNameJa: "霊夢",
        characterNameEn: "Reimu",
      }),
    ).toBe("霊夢 / Reimu (博麗　霊夢)");

    expect(
      formatCharacter({
        ...sampleReplay,
        character: "霊夢",
        characterNameJa: "霊夢",
        characterNameEn: "Reimu",
      }),
    ).toBe("霊夢 / Reimu");

    expect(
      formatCharacter({
        ...sampleReplay,
        character: "Unknown",
        characterNameJa: null,
        characterNameEn: null,
      }),
    ).toBe("Unknown");

    expect(
      formatCharacter({
        ...sampleReplay,
        character: null,
        characterNameJa: null,
        characterNameEn: null,
      }),
    ).toBe("-");
  });

  it("formatSplitsTable formats table", () => {
    const table = formatSplitsTable(sampleReplay.splits);
    expect(table).toContain("Stage");
    expect(table).toContain("Score");
    expect(table).toContain("2 (1)");
    expect(table).toContain("2m 05s");
  });

  it("formatReplayText formats summary text", () => {
    const text = formatReplayText("th7_01.rpy", sampleReplay);
    expect(text).toContain("File:        th7_01.rpy");
    expect(text).toContain("Game:        東方妖々夢 ～ Perfect Cherry Blossom. (th07)");
    expect(text).toContain("Player:      Hakata");
    expect(text).toContain("Date:        05/26/11");
    expect(text).toContain("Character:   霊符 / Reimu A (ReimuA)");
    expect(text).toContain("Difficulty:  Lunatic");
    expect(text).toContain("Stage:       Stage All Clear");
    expect(text).toContain("Score:       1,234,567,890");
    expect(text).toContain("Cleared:     Yes");
    expect(text).toContain("Duration:    14m 12s (51,120 frames)");
    expect(text).not.toContain("Splits:");

    const textWithSplits = formatReplayText("th7_01.rpy", sampleReplay, { splits: true });
    expect(textWithSplits).toContain("Splits:");
  });

  it("formatReplayJson outputs valid json with file field", () => {
    const jsonPretty = formatReplayJson("th7_01.rpy", sampleReplay, true);
    const parsed = JSON.parse(jsonPretty);
    expect(parsed.file).toBe("th7_01.rpy");
    expect(parsed.game).toBe("th07");
    expect(jsonPretty).toContain("\n");

    const jsonCompact = formatReplayJson("th7_01.rpy", sampleReplay, false);
    expect(jsonCompact).not.toContain("\n");
    expect(JSON.parse(jsonCompact).file).toBe("th7_01.rpy");
  });
});
