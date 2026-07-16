import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import type { CreateUploadRequest, CreateUploadResponse } from "@sattori/shared";
import { loadConfig } from "../config.js";
import { error, json, parseBody } from "../http.js";
import { createPresignedUpload } from "../uploads.js";

/**
 * POST /uploads
 * .rpy アップロード用の署名付き URL を発行する。ファイル自体はブラウザから
 * S3 へ直接 PUT されるため、Lambda はファイル本体を経由しない。
 */
export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const config = loadConfig();
  const body = parseBody<CreateUploadRequest>(event);
  if (!body || typeof body.filename !== "string" || typeof body.size !== "number") {
    return error(400, "invalid_request", "filename と size は必須です");
  }
  if (!body.filename.toLowerCase().endsWith(".rpy")) {
    return error(400, "invalid_file", "リプレイファイル（.rpy）を指定してください");
  }
  if (body.size <= 0 || body.size > config.maxReplayBytes) {
    return error(413, "file_too_large", "リプレイファイルのサイズが上限を超えています");
  }

  const upload = await createPresignedUpload(config.uploadBucket);
  const response: CreateUploadResponse = {
    replayKey: upload.replayKey,
    uploadUrl: upload.uploadUrl,
  };
  return json(200, response);
};
