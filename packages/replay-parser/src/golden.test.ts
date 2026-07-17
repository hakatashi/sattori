import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseReplay } from "./index.js";
import type { ParsedReplay } from "./types.js";

const FIXTURES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../test-fixtures");

interface FixtureCase {
  label: string;
  rpyPath: string;
  expectedPath: string;
}

function collectFixtures(): FixtureCase[] {
  const cases: FixtureCase[] = [];
  for (const game of readdirSync(FIXTURES_DIR).sort()) {
    const gameDir = path.join(FIXTURES_DIR, game);
    if (!statSync(gameDir).isDirectory()) continue;
    for (const file of readdirSync(gameDir)
      .filter((f) => f.endsWith(".rpy"))
      .sort()) {
      cases.push({
        label: `${game}/${file}`,
        rpyPath: path.join(gameDir, file),
        expectedPath: path.join(gameDir, file.replace(/\.rpy$/, ".expected.json")),
      });
    }
  }
  return cases;
}

const fixtures = collectFixtures();

describe("golden replay fixtures (test-fixtures/**)", () => {
  it("found the expected number of checked-in fixtures", () => {
    // Guards against the case where fixture collection itself fails and
    // returns 0 cases, which would silently make the subsequent it.each
    // empty and look like "everything passed."
    expect(fixtures.length).toBe(24);
  });

  it.each(fixtures)("$label: all properties (including splits breakdown) match the golden JSON", ({ rpyPath, expectedPath }) => {
    const data = new Uint8Array(readFileSync(rpyPath));
    const expected = JSON.parse(readFileSync(expectedPath, "utf8")) as ParsedReplay;
    const result = parseReplay(data);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.replay).toEqual(expected);
  });
});
