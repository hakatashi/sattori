import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import type { AdminSettingsResponse, UpdateAdminSettingsRequest } from "@sattori/shared";
import { estimateCurrentMonthCostUsd } from "../../adminCosts.js";
import { loadConfig } from "../../config.js";
import { error, json, parseBody } from "../../http.js";
import { updateSettings } from "../../settings.js";

/**
 * POST /admin/settings
 * キルスイッチ・月間コストガード閾値の更新（管理画面。Issue #14）。認可はAPI
 * Gateway側のLambda Authorizerが担う。DELETE/PATCHと同様、HTTPメソッドを増やすと
 * `corsPreflight.allowMethods`の拡張が要る（`admin/stopJob.ts`・`admin/retryJob.ts`と
 * 同じ理由）ため、更新系だがPOSTに揃えている。
 *
 * 指定したフィールドだけを更新する（両方渡す必要はない）。`acceptingNewJobs:
 * false`がキルスイッチ本体——`requestMagicLink.ts`はキャッシュせず毎回参照するため、
 * ここでの変更は次のリクエストから即座に反映される。`monthlyCostLimitUsd`側は
 * ユーザー向け経路が当月コストを数分キャッシュしている（`costGuard.ts`参照）ため、
 * 閾値変更の反映が最大数分遅れうる。
 */
export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const config = loadConfig();
  const body = parseBody<UpdateAdminSettingsRequest>(event);
  if (!body || (body.acceptingNewJobs === undefined && body.monthlyCostLimitUsd === undefined)) {
    return error(
      400,
      "invalid_request",
      "acceptingNewJobs か monthlyCostLimitUsd のいずれかを指定してください",
    );
  }
  if (body.acceptingNewJobs !== undefined && typeof body.acceptingNewJobs !== "boolean") {
    return error(400, "invalid_request", "acceptingNewJobs はboolean で指定してください");
  }
  if (body.monthlyCostLimitUsd !== undefined) {
    if (typeof body.monthlyCostLimitUsd !== "number" || !Number.isFinite(body.monthlyCostLimitUsd) || body.monthlyCostLimitUsd <= 0) {
      return error(400, "invalid_request", "monthlyCostLimitUsd は正の数値で指定してください");
    }
  }

  const settings = await updateSettings(config.settingsTable, body);
  console.log(JSON.stringify({ event: "admin_settings_updated", ...body }));

  const currentMonthCostUsd = await estimateCurrentMonthCostUsd(config.jobsTable, new Date());
  const response: AdminSettingsResponse = {
    ...settings,
    currentMonthCostUsd,
    costLimitReached: currentMonthCostUsd >= settings.monthlyCostLimitUsd,
  };
  return json(200, response);
};
