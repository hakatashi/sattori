import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseReplay } from "@sattori/replay-parser";
import { describe, expect, it } from "vitest";
import { fromParsedReplay } from "./replay.js";

/**
 * Issue #7 の完了条件（th07リプレイから ReplayInfo を抽出できる）を、
 * replay-parser -> fromParsedReplay という実際の利用経路そのままで検証する。
 * フィクスチャは `packages/replay-parser/test-fixtures/**` にチェックイン済みの
 * 実リプレイ（ユーザー自身の作成物）を参照する。
 */
const FIXTURE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../replay-parser/test-fixtures/th07/th7_07.rpy",
);

describe("replay-parser -> ReplayInfo end-to-end (th07)", () => {
  it("extracts a full ReplayInfo from a real th07 replay", async () => {
    const data = new Uint8Array(await readFile(FIXTURE_PATH));
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
