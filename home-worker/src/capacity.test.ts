/** 余力判定（capacity）のテスト。 */
import { describe, expect, it } from "vitest";
import { canAccept, loadPerCpu } from "./capacity.js";
import { makeConfig } from "./testing.js";

describe("loadPerCpu", () => {
  it("ロードアベレージはコア数で割る", () => {
    expect(loadPerCpu({ loadavg: () => [4, 0, 0], cpuCount: () => 8 })).toBe(0.5);
  });

  it("ロードアベレージを取得できない環境では0扱い", () => {
    expect(
      loadPerCpu({
        loadavg: () => {
          throw new Error("unsupported");
        },
        cpuCount: () => 8,
      }),
    ).toBe(0);
  });
});

describe("canAccept", () => {
  it("空きがあり負荷も低ければ受け付ける", () => {
    expect(canAccept(makeConfig(), 0, 0.1)).toBe(true);
  });

  it("同時実行の上限に達していれば受け付けない", () => {
    expect(canAccept(makeConfig({ maxConcurrency: 2 }), 2, 0)).toBe(false);
  });

  it("負荷が高ければ空きがあっても受け付けない", () => {
    // 実行中ジョブを止める判断ではない（新規claimだけを止める、Issue #49 論点4）。
    expect(canAccept(makeConfig(), 0, 0.9)).toBe(false);
  });
});
