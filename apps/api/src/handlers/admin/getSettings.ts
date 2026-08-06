import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import type { AdminSettingsResponse } from "@sattori/shared";
import { estimateCurrentMonthCostUsd } from "../../adminCosts.js";
import { loadConfig } from "../../config.js";
import { json } from "../../http.js";
import { getSettings } from "../../settings.js";

/**
 * GET /admin/settings
 * キルスイッチ・月間コストガード閾値の現在値を返す（管理画面。Issue #14）。
 * 認可はAPI Gateway側のLambda Authorizerが担う。
 *
 * `currentMonthCostUsd`はユーザー向け経路（`requestMagicLink.ts`）が使う
 * `getCachedMonthlyCostUsd()`とは別に、この画面用には毎回`JobsTable`を
 * 全件Scanして最新値を計算する（管理画面の閲覧頻度は低く、鮮度を優先する）。
 */
export const handler: APIGatewayProxyHandlerV2 = async () => {
  const config = loadConfig();
  const settings = await getSettings(config.settingsTable);
  const currentMonthCostUsd = await estimateCurrentMonthCostUsd(config.jobsTable, new Date());

  const response: AdminSettingsResponse = {
    ...settings,
    currentMonthCostUsd,
    costLimitReached: currentMonthCostUsd >= settings.monthlyCostLimitUsd,
  };
  return json(200, response);
};
