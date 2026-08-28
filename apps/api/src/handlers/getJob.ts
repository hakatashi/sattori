import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import {
  calculateDownloadExpiresAt,
  type GetJobResponse,
  isSlowMotionRecording,
} from "@sattori/shared";
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

  // `outputPath` が何を指すかはジョブによって変わる。解像度が実際に変わる録画
  // （th06/07/08/11）では録画そのままの副次版だが、解像度が変わらない録画
  // （th20）や低速録画では**変換結果そのもの**が入り、720p版は作られない
  // （`worker/convert.py` の `needs_separate_raw_output()`）。ファイル名の
  // ` #raw` 接尾辞は前者にだけ付けたいので、720p版の有無で役割を見分ける。
  const outputPathVariant = job.outputPath720p === null ? "delivery" : "raw";
  const downloadUrl =
    job.status === "done" && job.outputPath
      ? buildVideoDownloadUrl(config.cdnDomain, job.outputPath, job, outputPathVariant)
      : null;
  const downloadUrl720p =
    job.status === "done" && job.outputPath720p
      ? buildVideoDownloadUrl(config.cdnDomain, job.outputPath720p, job, "delivery")
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
    // `errorCode`はIssue #138で追加した属性のため、それ以前に失敗した旧ジョブでは
    // DynamoDB上に属性自体が無く`undefined`になりうる（`replayInfo`と同じ理由）。
    errorCode: job.errorCode ?? null,
    updatedAt: job.updatedAt,
    progress: job.progress,
    previewVideoUrl,
    previewImageUrl,
    replayInfo: job.replayInfo ?? null,
    // ユーザーの希望（`options.slowMotion`）そのままではなく、EC2へフォールバック
    // したかどうかまで織り込んだ「実際に低速録画で走るか」を返す（Issue #68）。
    slowMotion: isSlowMotionRecording(job.options, job.workerKind),
    // `errorCode`と同じ理由（Issue #103追加より前の旧ジョブでは属性自体が無く
    // `undefined`になりうる）で`?? null`を通す。
    desyncDetected: job.desyncDetected ?? null,
    // 同じ理由（Issue #161追加より前の旧ジョブでは属性自体が無く`undefined`になりうる）。
    timedOut: job.timedOut ?? null,
  };
  return json(200, response);
};
