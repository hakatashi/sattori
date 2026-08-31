import { describe, expect, it } from "vitest";
import {
  isSupportedGame,
  isTerminalStatus,
  DEFAULT_RECORDING_OPTIONS,
  ADMIN_JOB_LIST_DEFAULT_LIMIT,
  ADMIN_JOB_LIST_MAX_LIMIT,
  DEFAULT_MONTHLY_COST_LIMIT_USD,
} from "./index.js";

describe("shared", () => {
  it("th06・th07・th08・th11・th12 が録画対応タイトル(Issue #13でth08、th06対応でth06、th11対応でth11、th12対応でth12を追加)", () => {
    expect(isSupportedGame("th06")).toBe(true);
    expect(isSupportedGame("th07")).toBe(true);
    expect(isSupportedGame("th08")).toBe(true);
    expect(isSupportedGame("th11")).toBe(true);
    expect(isSupportedGame("th12")).toBe(true);
    // th13以降はパーサー的には認識できるが録画には未対応(MOD移植が未着手)。
    expect(isSupportedGame("th13")).toBe(false);
  });

  it("終端状態を正しく判定する", () => {
    expect(isTerminalStatus("done")).toBe(true);
    expect(isTerminalStatus("failed")).toBe(true);
    expect(isTerminalStatus("recording")).toBe(false);
    expect(isTerminalStatus("queued")).toBe(false);
  });

  it("ウォーターマークはデフォルトON", () => {
    expect(DEFAULT_RECORDING_OPTIONS.watermark).toBe(true);
  });

  it("管理API(admin.ts)の定数がindexからre-exportされている(Issue #51)", () => {
    expect(ADMIN_JOB_LIST_DEFAULT_LIMIT).toBe(20);
    expect(ADMIN_JOB_LIST_MAX_LIMIT).toBe(100);
  });

  it("月間コストガード(settings.ts)の既定値がindexからre-exportされている(Issue #14)", () => {
    expect(DEFAULT_MONTHLY_COST_LIMIT_USD).toBe(50);
  });
});
