import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import {
  ADMIN_COST_BUCKET_DEFAULT_LIMIT,
  ADMIN_COST_BUCKET_MAX_LIMIT,
  COST_GRANULARITIES,
} from "@sattori/shared";
import type { AdminCostSummaryResponse } from "@sattori/shared";
import { parseGranularity, summarizeCosts } from "../../adminCosts.js";
import { loadConfig } from "../../config.js";
import { error, json } from "../../http.js";

/** バケット数を範囲内へクランプする。不正値は既定値（`adminJobs.ts`の`normalizeLimit`と同じ流儀）。 */
function normalizeBucketLimit(raw: string | undefined): number {
  const parsed = raw !== undefined ? Number(raw) : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return ADMIN_COST_BUCKET_DEFAULT_LIMIT;
  }
  return Math.min(Math.floor(parsed), ADMIN_COST_BUCKET_MAX_LIMIT);
}

/**
 * GET /admin/costs?granularity=&limit=
 * ジョブのコスト推定を日次/週次/月次で集計して返す（管理画面。Issue #60）。
 * 認可はAPI Gateway側のLambda Authorizerが担う。
 *
 * 返すのは**請求額ではなく推定値**（単価と算出モデルは
 * `packages/shared/src/cost.ts`）。集計は`JobsTable`の全件Scanで行う——月1000
 * ジョブ規模では素朴なScanで十分という判断（`adminCosts.ts`参照）。
 */
export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const config = loadConfig();
  const query = event.queryStringParameters ?? {};

  const granularityParam = query.granularity;
  const granularity = granularityParam === undefined ? "monthly" : parseGranularity(granularityParam);
  if (granularity === null) {
    return error(
      400,
      "invalid_granularity",
      `granularityが不正です: ${granularityParam}（${COST_GRANULARITIES.join(" | ")}）`,
    );
  }

  const result = await summarizeCosts(config.jobsTable, {
    granularity,
    limit: normalizeBucketLimit(query.limit),
    now: new Date(),
  });

  const response: AdminCostSummaryResponse = {
    granularity,
    jobCount: result.jobCount,
    buckets: result.buckets,
    cloudFront: result.cloudFront,
    quality: result.quality,
    totalJobCount: result.totalJobCount,
  };
  return json(200, response);
};
