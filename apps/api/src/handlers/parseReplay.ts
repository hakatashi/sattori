import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { parseReplayInfo, type ParseReplayRequest, type ParseReplayResponse } from "@sattori/shared";
import { loadConfig } from "../config.js";
import { error, json, parseBody } from "../http.js";

const s3 = new S3Client({});

/**
 * POST /replays/parse
 * アップロード済みの .rpy（アップロード用S3）を取得して解析し、ページAのプレビューに
 * 必要な `ReplayInfo` を返す。非対応タイトル・非対応フォーマット・破損ファイルは
 * 422 + ApiError（`code` は `ReplayParseErrorCode`）で返し、フロントはその場でエラー表示して
 * 「次のステップ」を非活性のままにする（Issue #16 の再発防止）。
 */
export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const config = loadConfig();
  const body = parseBody<ParseReplayRequest>(event);
  if (!body || typeof body.replayKey !== "string") {
    return error(400, "invalid_request", "replayKey は必須です");
  }

  let data: Uint8Array;
  try {
    const object = await s3.send(
      new GetObjectCommand({ Bucket: config.uploadBucket, Key: body.replayKey }),
    );
    data = await object.Body!.transformToByteArray();
  } catch {
    return error(404, "replay_not_found", "アップロードされたリプレイファイルが見つかりません");
  }

  const result = parseReplayInfo(data);
  if (!result.ok) {
    return error(422, result.error.code, result.error.message);
  }

  const response: ParseReplayResponse = result.info;
  return json(200, response);
};
