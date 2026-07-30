import { afterEach, describe, expect, it } from "vitest";
import { clearAdminToken, loadAdminToken, saveAdminToken } from "./adminToken.ts";

describe("adminToken", () => {
  afterEach(() => {
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
});
