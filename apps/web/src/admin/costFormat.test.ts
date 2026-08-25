import { describe, expect, it } from "vitest";
import { formatBytes } from "./costFormat.ts";

describe("formatBytes", () => {
  it("GiB以上ならGiB表示、それ未満はMiB表示にする", () => {
    expect(formatBytes(2 * 1024 ** 3)).toBe("2.00 GiB");
    expect(formatBytes(500 * 1024 ** 2)).toBe("500 MiB");
  });

  it("0以下は「-」にする", () => {
    expect(formatBytes(0)).toBe("-");
    expect(formatBytes(-1)).toBe("-");
  });

  it("undefined/NaNを渡しても「NaN MiB」にならず「-」にする（デプロイ前後のAPI不整合対策、Issue #163）", () => {
    expect(formatBytes(undefined as unknown as number)).toBe("-");
    expect(formatBytes(Number.NaN)).toBe("-");
  });
});
