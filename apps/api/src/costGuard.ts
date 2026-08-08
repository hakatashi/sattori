import { estimateCurrentMonthCostUsd } from "./adminCosts.js";

/**
 * 月間コストガード（Issue #14）のユーザー向けチェック（`requestMagicLink.ts`）専用。
 * 当月コストの算出は`JobsTable`の全件Scanを要する（`adminCosts.ts`参照）ため、
 * マジックリンク要求のたびに毎回計算すると、無関係なリクエストの集中（濫用試行を
 * 含む）がScanのコスト・レイテンシを押し上げてしまう——コストガードを守るための
 * チェック自体がコストを増やす本末転倒を避けるため、Lambda実行コンテキストに短時間
 * キャッシュする。`adminAuth.ts`のSSMトークンキャッシュと同じ考え方。
 *
 * 管理画面での閾値変更・キルスイッチ切替はこの遅延の影響を受けない
 * （`getSettings()`はキャッシュせず毎回GetItemする、`settings.ts`参照）。この関数が
 * 返す当月コスト自体だけが最大`COST_GUARD_CACHE_TTL_MS`遅れうる。
 */
export const COST_GUARD_CACHE_TTL_MS = 5 * 60 * 1000;

let cachedCostUsd: number | null = null;
let cachedAt = 0;

/** テスト用: モジュールスコープのキャッシュをリセットする。 */
export function resetCostGuardCache(): void {
  cachedCostUsd = null;
  cachedAt = 0;
}

export async function getCachedMonthlyCostUsd(jobsTable: string): Promise<number> {
  const now = Date.now();
  if (cachedCostUsd !== null && now - cachedAt < COST_GUARD_CACHE_TTL_MS) {
    return cachedCostUsd;
  }
  const value = await estimateCurrentMonthCostUsd(jobsTable, new Date(now));
  cachedCostUsd = value;
  cachedAt = now;
  return value;
}
