import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseReplay } from "./index.js";
import type { ParsedReplay } from "./types.js";

/**
 * このパッケージのゴールデンテストは `test-fixtures/**` にチェックインされた
 * 実リプレイのみを使う。すべてユーザー自身（hakatashi）が実際にプレイして
 * 作成したファイル（player が "koyi" 系）であることを確認済みで、著作権上の
 * 懸念がないためリポジトリに含めている（`.gitignore` の `*.rpy` ルールに対する
 * 明示的な例外）。Silent Selene 等の第三者由来ファイルはここには含めない。
 */
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
    // フィクスチャの取得自体が失敗して 0 件になった場合、以降の it.each が
    // silently 空になって「全部パスしたように見える」事故を防ぐためのガード。
    expect(fixtures.length).toBe(24);
  });

  it.each(fixtures)("$label: 全プロパティ(splits内訳含む)がゴールデンJSONと一致する", ({ rpyPath, expectedPath }) => {
    const data = new Uint8Array(readFileSync(rpyPath));
    const expected = JSON.parse(readFileSync(expectedPath, "utf8")) as ParsedReplay;
    const result = parseReplay(data);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.replay).toEqual(expected);
  });
});

describe("golden replay fixtures: spot-checked against in-game screenshots", () => {
  // 以下は touhou-recorder/games/**/*.png のゲーム画面スクリーンショットと
  // 目視で突き合わせ済みの値（player/date/character/difficulty/score）。
  // ゴールデンJSON自体が誤って再生成された場合の検知用に、主要ゲームだけ
  // 独立した期待値でも確認する。

  it("th06: th6_02.rpy", () => {
    const data = new Uint8Array(readFileSync(path.join(FIXTURES_DIR, "th06/th6_02.rpy")));
    const result = parseReplay(data);
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

  it("th07: th7_07.rpy", () => {
    const data = new Uint8Array(readFileSync(path.join(FIXTURES_DIR, "th07/th7_07.rpy")));
    const result = parseReplay(data);
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

  it("th08: th8_02.rpy (Shift_JIS character name)", () => {
    const data = new Uint8Array(readFileSync(path.join(FIXTURES_DIR, "th08/th8_02.rpy")));
    const result = parseReplay(data);
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

  it("th11: th11_01.rpy", () => {
    const data = new Uint8Array(readFileSync(path.join(FIXTURES_DIR, "th11/th11_01.rpy")));
    const result = parseReplay(data);
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

  it("th13: th13_01.rpy (t13r magic, version byte 144 selects TD)", () => {
    const data = new Uint8Array(readFileSync(path.join(FIXTURES_DIR, "th13/th13_01.rpy")));
    const result = parseReplay(data);
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

  it("th14: th14_01.rpy (t13r magic, non-144 version byte selects DDC)", () => {
    const data = new Uint8Array(readFileSync(path.join(FIXTURES_DIR, "th14/th14_01.rpy")));
    const result = parseReplay(data);
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

  it("th15: th15_01.rpy", () => {
    const data = new Uint8Array(readFileSync(path.join(FIXTURES_DIR, "th15/th15_01.rpy")));
    const result = parseReplay(data);
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

  it("th20: th20_01.rpy (undocumented format, userdata-only support)", () => {
    const data = new Uint8Array(readFileSync(path.join(FIXTURES_DIR, "th20/th20_01.rpy")));
    const result = parseReplay(data);
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

  it("th125: th125_01.rpy", () => {
    const data = new Uint8Array(readFileSync(path.join(FIXTURES_DIR, "th125/th125_01.rpy")));
    const result = parseReplay(data);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.replay).toMatchObject({
      game: "th125",
      player: "koyi",
      character: "Aya",
    });
  });

  it("th143: th143_01.rpy", () => {
    const data = new Uint8Array(readFileSync(path.join(FIXTURES_DIR, "th143/th143_01.rpy")));
    const result = parseReplay(data);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.replay).toMatchObject({
      game: "th143",
      player: "koyi",
    });
  });
});
