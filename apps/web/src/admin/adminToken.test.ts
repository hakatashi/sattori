import { afterEach, describe, expect, it, vi } from "vitest";
import { clearAdminToken, loadAdminToken, saveAdminToken } from "./adminToken.ts";

describe("adminToken", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    clearAdminToken();
  });

  it("未保存の場合はnullを返す", () => {
    expect(loadAdminToken()).toBeNull();
  });

  it("保存したトークンを読み出せる", () => {
    saveAdminToken("secret-token");
    expect(loadAdminToken()).toBe("secret-token");
  });

  it("クリアするとnullに戻る", () => {
    saveAdminToken("secret-token");
    clearAdminToken();
    expect(loadAdminToken()).toBeNull();
  });

  it("localStorageが使えない環境でも例外を投げない(プライベートブラウジング等)", () => {
    // 画面が白くなるのを防ぐため、保存・クリアも読み出しと同様に握り潰す。
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError");
    });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("SecurityError");
    });

    expect(() => saveAdminToken("secret-token")).not.toThrow();
    expect(() => clearAdminToken()).not.toThrow();
  });
});
