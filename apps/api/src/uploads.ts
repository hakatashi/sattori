import { randomUUID } from "node:crypto";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const s3 = new S3Client({});

/** 署名付き URL の有効期限（秒）。 */
const UPLOAD_URL_TTL_SEC = 300;

export interface PresignedUpload {
  replayKey: string;
  uploadUrl: string;
}

/**
 * .rpy アップロード用の署名付き PUT URL を発行する。
 * オブジェクトキーはサーバー側で採番し、クライアントの入力に依存しない。
 */
export async function createPresignedUpload(bucket: string): Promise<PresignedUpload> {
  const replayKey = `replays/${randomUUID()}.rpy`;
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: replayKey,
    ContentType: "application/octet-stream",
  });
  const uploadUrl = await getSignedUrl(s3, command, { expiresIn: UPLOAD_URL_TTL_SEC });
  return { replayKey, uploadUrl };
}
