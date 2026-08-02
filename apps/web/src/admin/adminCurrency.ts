import { createContext, useContext } from "react";

/**
 * 管理画面のコスト表示通貨（Issue #60のコスト推定の表示切り替え）。計算自体は一貫してUSD
 * （`@sattori/shared`の`estimateJobCost()`）で行い、**表示の直前だけ円に換算する**。
 * 円建ての値を持ち回るとレート変更のたびに集計値の意味が変わってしまうため。
 */
export const COST_CURRENCIES = ["usd", "jpy"] as const;
export type CostCurrency = (typeof COST_CURRENCIES)[number];

const STORAGE_KEY = "sattori.adminCurrency";

/** USD既定。運用者が円で見たい場合だけ切り替える（AWSの請求はUSD建てのため）。 */
export const DEFAULT_COST_CURRENCY: CostCurrency = "usd";

function isCostCurrency(value: string | null): value is CostCurrency {
  return value !== null && (COST_CURRENCIES as readonly string[]).includes(value);
}

/**
 * 表示通貨の選択をlocalStorageで保持する（`adminToken.ts`と同じ方針）。
 * 読めない・書けない環境では既定値にフォールバックするだけで、画面は動き続ける。
 */
export function loadCostCurrency(): CostCurrency {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return isCostCurrency(stored) ? stored : DEFAULT_COST_CURRENCY;
  } catch {
    return DEFAULT_COST_CURRENCY;
  }
}

export function saveCostCurrency(currency: CostCurrency): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, currency);
  } catch {
    // 保存できなくても切り替え自体は成立させる（次回リロードで既定に戻るだけ）。
  }
}

export interface CostCurrencyValue {
  currency: CostCurrency;
  setCurrency: (currency: CostCurrency) => void;
}

/**
 * Provider外でも既定値（USD・切り替え不可）で動くようにしてある。`useAdminAuth`と違い
 * 通貨は表示上の好みでしかなく、Provider忘れで画面を落とす価値が無いため。
 */
export const CostCurrencyContext = createContext<CostCurrencyValue>({
  currency: DEFAULT_COST_CURRENCY,
  setCurrency: () => {},
});

export function useCostCurrency(): CostCurrencyValue {
  return useContext(CostCurrencyContext);
}
