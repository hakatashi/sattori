import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { calculateDownloadExpiresAt, type GetJobResponse } from "@sattori/shared";
import { loadConfig } from "../config.js";
import { buildCdnUrl, buildVideoDownloadUrl } from "../downloads.js";
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
      ? buildVideoDownloadUrl(config.cdnDomain, job.outputPath, job, "original")
      : null;
  const downloadUrl720p =
    job.status === "done" && job.outputPath720p
      ? buildVideoDownloadUrl(config.cdnDomain, job.outputPath720p, job, "720p")
      : null;
  // ページBのプレビュープレイヤー(Issue #71)用のURL。ダウンロード用と違い
  // `response-content-disposition`を付けない(付けるとCloudFrontのキャッシュキーが
  // 変わってしまい、ダウンロードとプレビューでキャッシュを共有できない)。
  // 720p版を優先するのは、主要ダウンロードボタンと同じ「ユーザーが受け取る成果物」を
  // そのまま見せるため(ウォーターマークもこちらにのみ合成されている)。
  const previewOutputPath =
    job.status === "done" ? (job.outputPath720p ?? job.outputPath ?? null) : null;
  const previewVideoUrl = previewOutputPath
    ? buildCdnUrl(config.cdnDomain, previewOutputPath)
    : null;
  // プレビュー画像は録画・変換の進行中に加え、完了後はプレビュープレイヤーの
  // poster として使う(再生前に真っ黒な矩形を出さないため)。失敗後は表示しない。
  const previewImageUrl =
    (job.status === "recording" || job.status === "converting" || job.status === "done") &&
    job.previewImagePath
      ? buildCdnUrl(config.cdnDomain, job.previewImagePath)
      : null;

  const response: GetJobResponse = {
    jobId: job.jobId,
    game: job.game,
    status: job.status,
    downloadUrl,
    downloadUrl720p,
    downloadExpiresAt: job.status === "done" ? calculateDownloadExpiresAt(job.doneAt) : null,
    error: job.error,
    updatedAt: job.updatedAt,
    progress: job.progress,
    previewVideoUrl,
    previewImageUrl,
    replayInfo: job.replayInfo ?? null,
  };
  return json(200, response);
};
