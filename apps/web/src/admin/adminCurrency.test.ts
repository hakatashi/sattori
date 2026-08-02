import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_COST_CURRENCY, loadCostCurrency, saveCostCurrency } from "./adminCurrency.ts";

describe("adminCurrency", () => {
  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("保存した通貨を読み戻す", () => {
    saveCostCurrency("jpy");
    expect(loadCostCurrency()).toBe("jpy");
  });

  it("未保存なら既定通貨（USD）", () => {
    expect(loadCostCurrency()).toBe(DEFAULT_COST_CURRENCY);
  });

  it("未知の値が入っていても既定通貨にフォールバックする", () => {
    window.localStorage.setItem("sattori.adminCurrency", "eur");
    expect(loadCostCurrency()).toBe(DEFAULT_COST_CURRENCY);
  });

  it("localStorageが使えなくても例外にしない", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });

    expect(loadCostCurrency()).toBe(DEFAULT_COST_CURRENCY);
    expect(() => saveCostCurrency("jpy")).not.toThrow();
  });
});
