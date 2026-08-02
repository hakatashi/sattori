import {
  GetObjectCommand,
  HeadObjectCommand,
  NoSuchKey,
  NotFound,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { buildContentDispositionValue, buildDownloadFilename } from "@sattori/shared";
import type { JobRecord } from "@sattori/shared";

const s3 = new S3Client({});

/**
 * ファイルダウンロード関連の共通処理。`uploads.ts` はアップロード(PUT)用の
 * 署名発行の場所なので、GET系(動画URL組み立て・.rpyの署名付きダウンロード)は
 * こちらにまとめる（Issue #51、管理画面から使うほか `getJob.ts` の動画URL組み立ても
 * ここへ移設して共有する）。
 */

/**
 * 動画のダウンロードURLを組み立てる。`response-content-disposition` クエリ
 * パラメータはS3のGetObject APIがそのままレスポンスヘッダーへエコーバックする
 * ため、これを付与するだけでブラウザ標準のダウンロード機構（進捗表示・タブを
 * 離れても継続・ディスクへの直接ストリーミング）を使わせられる（フロントエンド側の
 * fetch+Blob化が不要。詳細はAGENTS.md参照）。
 */
export function buildVideoDownloadUrl(
  cdnDomain: string,
  outputPath: string,
  job: Pick<JobRecord, "jobId" | "replayInfo">,
  variant: "720p" | "original",
): string {
  const filename = buildDownloadFilename(job.jobId, job.replayInfo, variant);
  const url = new URL(`https://${cdnDomain}/${outputPath}`);
  url.searchParams.set("response-content-disposition", buildContentDispositionValue(filename));
  return url.toString();
}

/** CloudFront配信パスから配信URLを組み立てる（進捗プレビュー画像など）。 */
export function buildCdnUrl(cdnDomain: string, path: string): string {
  return `https://${cdnDomain}/${path}`;
}

/**
 * .rpyダウンロード用署名付きURLの有効期限（秒）。アップロード用(300秒)より長め。
 * 管理者が詳細画面を開いたまま放置してからクリックする運用を想定しつつ、
 * URL漏洩時の露出時間を抑えるためにあまり長くしない。
 */
export const REPLAY_DOWNLOAD_URL_TTL_SEC = 900;

/**
 * アップロード済み.rpyへの署名付きGET URLを発行する（管理画面専用。UploadBucketは
 * CloudFrontで配信していない`BLOCK_ALL`バケットのため、動画と違いS3署名付きURLを
 * 直接使う）。`ResponseContentDisposition`を署名に含めることで、動画DLと同様に
 * `<a href download>`だけでブラウザ標準のダウンロード機構を使わせられる。
 */
export async function createPresignedReplayDownloadUrl(
  bucket: string,
  key: string,
  filename: string,
): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
    ResponseContentDisposition: buildContentDispositionValue(filename),
  });
  return getSignedUrl(s3, command, { expiresIn: REPLAY_DOWNLOAD_URL_TTL_SEC });
}

/**
 * 720p変換のffmpeg生ログ（`worker/entrypoint.py`の`FFMPEG_UPSCALE_LOG_KEY`、
 * Issue #58フォローアップ）のS3キーを組み立てる。jobIdから決定的に導出できるため、
 * `stepFunctions.ts`の`buildExecutionArn`と同様にDynamoDBには保存しない。
 */
export function buildFfmpegUpscaleLogKey(jobId: string): string {
  return `worker-logs/${jobId}/ffmpeg-upscale.log`;
}

/**
 * ffmpeg生ログへの署名付きGET URLを発行する（管理画面専用）。動画と違いCDN配信は
 * しない（一般ユーザー向け配信物ではなく、ライフサイクルルールで3日と短命なため）。
 */
export async function createPresignedFfmpegLogDownloadUrl(bucket: string, key: string): Promise<string> {
  const command = new GetObjectCommand({ Bucket: bucket, Key: key });
  return getSignedUrl(s3, command, { expiresIn: REPLAY_DOWNLOAD_URL_TTL_SEC });
}

/**
 * S3オブジェクトの存在確認（HeadObject）。手動削除等で実体が無い場合に
 * 死んだダウンロードリンクを出さないようにするために使う。表示の分岐にしか
 * 使わないため、失敗の理由を問わず「無い」に倒す（＝リンクを出さない）。
 *
 * 「無いこと」を根拠に処理そのものを止める側（`retryJob.ts`）は、一時障害を
 * 「削除済み」と誤断定しないよう`objectExistsStrict()`を使うこと。
 */
export async function objectExists(bucket: string, key: string): Promise<boolean> {
  try {
    return await objectExistsStrict(bucket, key);
  } catch {
    return false;
  }
}

/**
 * S3オブジェクトの存在確認（HeadObject）。`objectExists()`と違い、404以外の失敗
 * （スロットリング・5xx・権限/KMSエラー等）はそのまま投げる。
 *
 * 呼び出し側が「オブジェクトが無い」ことをユーザー（管理者）への断定的な説明や
 * 処理の中断理由にする場合、一時障害を「削除済み」と report してしまうと運用者を
 * 誤った原因調査へ誘導するため（Issue #59のレビュー指摘）。
 */
export async function objectExistsStrict(bucket: string, key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (err) {
    // HeadObjectはボディを返さないため、SDKは`NoSuchKey`ではなく汎用の`NotFound`
    // （404）を投げる。バケット自体が無い場合の`NoSuchBucket`は「削除済み」ではなく
    // 設定異常なので、ここでは404だけを「無い」として扱う。
    if (err instanceof NotFound || err instanceof NoSuchKey) {
      return false;
    }
    if (
      typeof err === "object" &&
      err !== null &&
      "$metadata" in err &&
      (err.$metadata as { httpStatusCode?: number } | undefined)?.httpStatusCode === 404
    ) {
      return false;
    }
    throw err;
  }
}
