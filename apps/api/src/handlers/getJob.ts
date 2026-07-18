import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import type { GetJobResponse } from "@sattori/shared";
import { loadConfig } from "../config.js";
import { error, json } from "../http.js";
import { getJob } from "../jobs.js";

/**
 * GET /jobs/{jobId}
 * ジョブの現在状態を返す（ページBがポーリングで利用）。
 * 完了時は CloudFront 経由のダウンロードURLを返す。
 */
export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const config = loadConfig();
  const jobId = event.pathParameters?.jobId;
  if (!jobId) {
    return error(400, "invalid_request", "jobId が指定されていません");
  }

  const job = await getJob(config.jobsTable, jobId);
  if (!job) {
    return error(404, "not_found", "ジョブが見つかりません");
  }

  const downloadUrl =
    job.status === "done" && job.outputPath
      ? `https://${config.cdnDomain}/${job.outputPath}`
      : null;
  const downloadUrl720p =
    job.status === "done" && job.outputPath720p
      ? `https://${config.cdnDomain}/${job.outputPath720p}`
      : null;

  const response: GetJobResponse = {
    jobId: job.jobId,
    game: job.game,
    status: job.status,
    downloadUrl,
    downloadUrl720p,
    error: job.error,
    updatedAt: job.updatedAt,
  };
  return json(200, response);
};
