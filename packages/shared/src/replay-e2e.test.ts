import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseReplay } from "@sattori/replay-parser";
import { describe, expect, it } from "vitest";
import { fromParsedReplay } from "./replay.js";

/**
 * Issue #7 の完了条件（th07リプレイから ReplayInfo を抽出できる）を、
 * replay-parser -> fromParsedReplay という実際の利用経路そのままで検証する。
 * 実ファイルは著作権物のためリポジトリに含めず、touhou-recorder が兄弟リポジトリ
 * として存在する環境でのみ実行する。
 */
const GAMES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../touhou-recorder/games");
const hasFixtures = existsSync(GAMES_DIR);

describe.skipIf(!hasFixtures)("replay-parser -> ReplayInfo end-to-end (th07)", () => {
  it("extracts a full ReplayInfo from a real th07 replay", async () => {
    const data = new Uint8Array(await readFile(path.join(GAMES_DIR, "th07/replay/th7_07.rpy")));
    const result = parseReplay(data);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const info = fromParsedReplay(result.replay);
    expect(info).toMatchObject({
      game: "th07",
      player: "koyi",
      character: "MarisaA",
      difficulty: "Extra",
      score: 303766040,
      cleared: true,
    });
  });
});
