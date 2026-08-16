import { GetObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";

const s3 = new S3Client({});

/** `replayKey` に対応するオブジェクトがアップロード用S3に存在しない（または取得に失敗した）。 */
export class ReplayNotFoundError extends Error {}

/** オブジェクトサイズが上限（`ApiConfig.maxReplayBytes`）を超えている。 */
export class ReplayTooLargeError extends Error {}

/**
 * アップロード済み .rpy（アップロード用S3）を取得する。`parseReplay.ts`（プレビューAPI）と
 * `requestMagicLink.ts`（ジョブレコードへの`replayInfo`転記用、Issue #133 OPS-1）の双方が
 * 使う共通処理。`replayKey`は任意のキーを指定できてしまう（発行元かの検証はしていない）
 * ため、先に`HeadObject`でサイズを確認してから中身をLambdaメモリへ読み込む——
 * `GetObject`をいきなり呼ぶと、巨大オブジェクトのアップロードと組み合わせて容易に
 * OOMさせられる（Issue #128 SEC-2）。
 */
export async function fetchReplayBytes(
  bucket: string,
  replayKey: string,
  maxBytes: number,
): Promise<Uint8Array> {
  let contentLength: number | undefined;
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: replayKey }));
    contentLength = head.ContentLength;
  } catch {
    throw new ReplayNotFoundError(replayKey);
  }
  if (contentLength !== undefined && contentLength > maxBytes) {
    throw new ReplayTooLargeError(replayKey);
  }
  try {
    const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: replayKey }));
    return await object.Body!.transformToByteArray();
  } catch {
    throw new ReplayNotFoundError(replayKey);
  }
}
