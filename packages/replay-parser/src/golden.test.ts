import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseReplay } from "./index.js";

/**
 * 東方の実リプレイファイルは著作権物のためリポジトリには含めない
 * （このリポジトリ全体で `*.rpy` は .gitignore 対象）。代わりに、開発機に
 * 兄弟リポジトリとして存在する `touhou-recorder/games/**` を参照する。
 * そのディレクトリが存在しない環境（CIやクローン直後）ではスキップされる。
 */
const GAMES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../touhou-recorder/games");
const hasFixtures = existsSync(GAMES_DIR);

async function loadFixture(relativePath: string): Promise<Uint8Array> {
  const data = await readFile(path.join(GAMES_DIR, relativePath));
  return new Uint8Array(data);
}

describe.skipIf(!hasFixtures)("golden replay fixtures (touhou-recorder/games)", () => {
  it("th06: th6_02.rpy", async () => {
    const result = parseReplay(await loadFixture("th06/replay/th6_02.rpy"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.replay).toMatchObject({
      game: "th06",
      player: "koyi",
      date: "05/26/11",
      character: "ReimuA",
      difficulty: "Normal",
      score: 66329830,
      cleared: false,
    });
  });

  it("th07: th7_07.rpy (screenshot-verified)", async () => {
    const result = parseReplay(await loadFixture("th07/replay/th7_07.rpy"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.replay).toMatchObject({
      game: "th07",
      formatVersion: 5,
      player: "koyi",
      date: "01/18",
      character: "MarisaA",
      difficulty: "Extra",
      score: 303766040,
      cleared: true,
    });
  });

  it("th07: th7_ud1mdq.rpy (formatVersion=3, a version historically flagged in Issue #16)", async () => {
    const result = parseReplay(await loadFixture("th07/replay/th7_ud1mdq.rpy"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.replay.formatVersion).toBe(3);
  });

  it("th08: th8_02.rpy (Shift_JIS character name)", async () => {
    const result = parseReplay(await loadFixture("th08/replay/th8_02.rpy"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.replay).toMatchObject({
      game: "th08",
      player: "koyi",
      date: "2026/01/23 23:55:08",
      character: "八雲　紫",
      difficulty: "Extra",
      score: 879440560,
      cleared: true,
    });
  });

  it("th11: th11_01.rpy", async () => {
    const result = parseReplay(await loadFixture("th11/replay/th11_01.rpy"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.replay).toMatchObject({
      game: "th11",
      player: "koyi",
      date: "14/12/04 18:24",
      character: "ReimuA",
      difficulty: "Easy",
      score: 258644590,
      cleared: true,
    });
    expect(result.replay.splits).toHaveLength(6);
  });

  it("th13: th13_01.rpy (t13r magic, version byte 144 disambiguates TD from DDC)", async () => {
    const result = parseReplay(await loadFixture("th13/replay/th13_01.rpy"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.replay).toMatchObject({
      game: "th13",
      formatVersion: 144,
      player: "koyi",
      character: "Reimu",
      difficulty: "Easy",
      score: 154721320,
      cleared: true,
    });
  });

  it("th14: th14_01.rpy (t13r magic, non-144 version byte selects DDC)", async () => {
    const result = parseReplay(await loadFixture("th14/replay/th14_01.rpy"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.replay).toMatchObject({
      game: "th14",
      player: "koyi",
      character: "ReimuA",
      difficulty: "Normal",
      score: 331723050,
      cleared: true,
    });
  });

  it("th15: th15_01.rpy", async () => {
    const result = parseReplay(await loadFixture("th15/replay/th15_01.rpy"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.replay).toMatchObject({
      game: "th15",
      date: "25/10/22 02:23",
      character: "Reimu",
      difficulty: "Hard",
      score: 30269670,
      cleared: false,
    });
  });

  it("th20: th20_01.rpy (undocumented format, userdata-only support)", async () => {
    const result = parseReplay(await loadFixture("th20/replay/th20_01.rpy"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.replay).toMatchObject({
      game: "th20",
      player: "koyi",
      date: "25/11/09 17:41",
      character: "Reimu",
      difficulty: "Hard",
      score: 481237400,
      cleared: true,
    });
  });
});
