import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import {
  buildContentDispositionValue,
  buildDownloadFilename,
  calculateDownloadExpiresAt,
  type GetJobResponse,
  type JobRecord,
} from "@sattori/shared";
import { loadConfig } from "../config.js";
import { error, json } from "../http.js";
import { getJob } from "../jobs.js";

/**
 * 動画のダウンロードURLを組み立てる。`response-content-disposition` クエリ
 * パラメータはS3のGetObject APIがそのままレスポンスヘッダーへエコーバックする
 * ため、これを付与するだけでブラウザ標準のダウンロード機構（進捗表示・タブを
 * 離れても継続・ディスクへの直接ストリーミング）を使わせられる（フロントエンド側の
 * fetch+Blob化が不要。詳細はAGENTS.md参照）。
 */
function buildDownloadUrl(
  cdnDomain: string,
  outputPath: string,
  job: JobRecord,
  variant: "720p" | "original",
): string {
  const filename = buildDownloadFilename(job.jobId, job.replayInfo, variant);
  const url = new URL(`https://${cdnDomain}/${outputPath}`);
  url.searchParams.set("response-content-disposition", buildContentDispositionValue(filename));
  return url.toString();
}

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
      ? buildDownloadUrl(config.cdnDomain, job.outputPath, job, "original")
      : null;
  const downloadUrl720p =
    job.status === "done" && job.outputPath720p
      ? buildDownloadUrl(config.cdnDomain, job.outputPath720p, job, "720p")
      : null;
  // プレビュー画像は録画・変換の進行中のみ意味を持つ(完了・失敗後は最新のダウンロード
  // 導線を優先し、古いスクリーンショットは表示しない)。
  const previewImageUrl =
    (job.status === "recording" || job.status === "converting") && job.previewImagePath
      ? `https://${config.cdnDomain}/${job.previewImagePath}`
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
    previewImageUrl,
    replayInfo: job.replayInfo ?? null,
  };
  return json(200, response);
};
