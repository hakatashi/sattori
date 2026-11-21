import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import type { AdminExperimentListResponse } from "@sattori/shared";
import { listExperimentJobs } from "../../adminJobs.js";
import { loadConfig } from "../../config.js";
import { toExperimentResult } from "../../experiments.js";
import { json } from "../../http.js";

/**
 * GET /admin/experiments
 * 実験ジョブ（Issue #397）の結果を新しい順にまとめて返す。検証レポートを書くときに、品質の判定値・
 * 速度・課金時間を1回の呼び出しで集めるためのもの。認可はLambda Authorizerが担う。
 */
export const handler: APIGatewayProxyHandlerV2 = async () => {
  const config = loadConfig();
  const now = new Date();
  const jobs = await listExperimentJobs(config.jobsTable);
  const response: AdminExperimentListResponse = { items: jobs.map((job) => toExperimentResult(job, now)) };
  return json(200, response);
};
