import { randomUUID } from "node:crypto";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const s3 = new S3Client({});

/** 署名付き URL の有効期限（秒）。 */
const UPLOAD_URL_TTL_SEC = 300;

/**
 * `createPresignedUpload()` が払い出すオブジェクトキーの形式。`randomUUID()` は
 * 小文字16進数+ハイフンの36文字を返すためこの形になる。`POST /magic-links` の
 * 入口検証（`handlers/requestMagicLink.ts`）が、この形式に一致しない `replayKey` を
 * 拒否するために参照する（Issue #127 SEC-1: サーバー採番の値かどうかを誰も検証して
 * いなかった）。**この関数のキー採番方式を変える場合はこの正規表現も合わせて
 * 変えること。**
 */
export const REPLAY_KEY_PATTERN = /^replays\/[0-9a-f-]{36}\.rpy$/;

export interface PresignedUpload {
  replayKey: string;
  uploadUrl: string;
}

/**
 * .rpy アップロード用の署名付き PUT URL を発行する。
 * オブジェクトキーはサーバー側で採番し、クライアントの入力に依存しない。
 *
 * `contentLength` を署名に含めることで、SigV4 の `X-Amz-SignedHeaders` に
 * `content-length` が乗り、実際の PUT リクエストのバイト数がこの値と完全一致しない
 * 限り S3 がリクエストを拒否するようになる（Issue #128 SEC-2:
 * それまでサイズ制約が署名に一切焼き込まれておらず、未認証で無制限に書き込めた）。
 * `createUpload.ts` が `MAX_REPLAY_BYTES` 以下であることを検証済みの値を渡す。
 * ブラウザの `fetch(url, { method: "PUT", body: file })` は File/Blob ボディの
 * `Content-Length` を自動算出して送るため、アップロードフロー自体の変更は不要
 * （`apps/web/src/api/client.ts` の `uploadReplay()`）。
 */
export async function createPresignedUpload(
  bucket: string,
  contentLength: number,
): Promise<PresignedUpload> {
  const replayKey = `replays/${randomUUID()}.rpy`;
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: replayKey,
    ContentType: "application/octet-stream",
    ContentLength: contentLength,
  });
  const uploadUrl = await getSignedUrl(s3, command, { expiresIn: UPLOAD_URL_TTL_SEC });
  return { replayKey, uploadUrl };
}
