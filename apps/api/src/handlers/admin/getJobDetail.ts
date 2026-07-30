import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import type { AdminJobDetailResponse, AdminJobDownloads } from "@sattori/shared";
import { loadConfig } from "../../config.js";
import {
  buildCdnUrl,
  buildVideoDownloadUrl,
  createPresignedReplayDownloadUrl,
  objectExists,
} from "../../downloads.js";
import { error, json } from "../../http.js";
import { getJob } from "../../jobs.js";

/**
 * GET /admin/jobs/{jobId}
 * ジョブの全フィールド(`JobRecord`)とダウンロード導線を返す（管理画面。Issue #51）。
 * ユーザー向け`GET /jobs/{jobId}`と異なり、statusが`done`でなくても実体があれば
 * ダウンロードURLを返す（`converting`中の生動画チェックポイントを取得したい場合が
 * あるため）。認可はAPI Gateway側のLambda Authorizerが担う。
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

  const replayUrl = (await objectExists(config.uploadBucket, job.replayKey))
    ? await createPresignedReplayDownloadUrl(config.uploadBucket, job.replayKey, `${job.jobId}.rpy`)
    : null;

  const videoUrl = job.outputPath
    ? buildVideoDownloadUrl(config.cdnDomain, job.outputPath, job, "original")
    : null;
  const video720pUrl = job.outputPath720p
    ? buildVideoDownloadUrl(config.cdnDomain, job.outputPath720p, job, "720p")
    : null;
  const previewImageUrl = job.previewImagePath
    ? buildCdnUrl(config.cdnDomain, job.previewImagePath)
    : null;

  const downloads: AdminJobDownloads = {
    replayUrl,
    videoUrl,
    video720pUrl,
    previewImageUrl,
  };

  const response: AdminJobDetailResponse = { job, downloads };
  return json(200, response);
};
