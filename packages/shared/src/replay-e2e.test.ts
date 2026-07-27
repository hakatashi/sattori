import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseReplay } from "@sattori/touhou-replay-parser";
import { describe, expect, it } from "vitest";
import { fromParsedReplay, parseReplayInfo } from "./replay.js";

/**
 * Issue #7 の完了条件（th07リプレイから ReplayInfo を抽出できる）を、
 * replay-parser -> fromParsedReplay という実際の利用経路そのままで検証する。
 * フィクスチャは `packages/replay-parser/test-fixtures/**` にチェックイン済みの
 * 実リプレイ（ユーザー自身の作成物）を参照する。
 */
const FIXTURES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../replay-parser/test-fixtures",
);
const TH06_FIXTURE = path.join(FIXTURES_DIR, "th06/th6_02.rpy");
const TH07_FIXTURE = path.join(FIXTURES_DIR, "th07/th7_07.rpy");
// th13 はパーサー的には認識できるが、Sattoriの録画対応タイトルには含まれない
// (isSupportedGame が false を返す) ため、parseReplayInfo の unsupported_game 検証に使う。
// (th11はth11対応で録画対応タイトルに追加されたため、この検証には使えなくなった)
const TH13_FIXTURE = path.join(FIXTURES_DIR, "th13/th13_01.rpy");

describe("replay-parser -> ReplayInfo end-to-end (th07)", () => {
  it("extracts a full ReplayInfo from a real th07 replay", async () => {
    const data = new Uint8Array(await readFile(TH07_FIXTURE));
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

describe("parseReplayInfo end-to-end (Issue #8)", () => {
  it("returns ReplayInfo（推定再生時間つき）for a real th07 replay", async () => {
    const data = new Uint8Array(await readFile(TH07_FIXTURE));
    const result = parseReplayInfo(data);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.info).toMatchObject({
      game: "th07",
      character: "MarisaA",
      difficulty: "Extra",
      score: 303766040,
      cleared: true,
    });
    expect(result.info.estimatedDurationSeconds).toBeGreaterThan(0);
  });

  it("録画対応タイトル（th06）は unsupported_game にならない", async () => {
    const data = new Uint8Array(await readFile(TH06_FIXTURE));
    const result = parseReplayInfo(data);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.info).toMatchObject({
      game: "th06",
      character: "ReimuA",
      difficulty: "Normal",
      score: 66329830,
    });
  });

  it("録画未対応タイトル（th13）は unsupported_game として日本語メッセージを返す", async () => {
    const data = new Uint8Array(await readFile(TH13_FIXTURE));
    const result = parseReplayInfo(data);
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.code).toBe("unsupported_game");
    expect(result.error.message).toContain("東方神霊廟");
  });

  it("破損ファイル（マジックバイト不正）は unknown_magic を返す", () => {
    const result = parseReplayInfo(new Uint8Array([0, 1, 2, 3, 4, 5]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("unknown_magic");
  });

  it("4バイト未満のファイルは too_short を返す", () => {
    const result = parseReplayInfo(new Uint8Array([0, 1]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("too_short");
  });
});
