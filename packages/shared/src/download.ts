import { GAME_TITLES } from "./games.js";
import { OUTPUT_RETENTION_DAYS } from "./job.js";
import type { ReplayInfo } from "./replay.js";

const HASHTAG = "#TouhouSattori";

/** OSのファイルシステムで使えない半角記号を、見た目の近い全角文字に置き換える。 */
function sanitizeFilename(value: string): string {
  return value
    .replaceAll("\\", "＼")
    .replaceAll("/", "／")
    .replaceAll(":", "：")
    .replaceAll("*", "＊")
    .replaceAll("?", "？")
    .replaceAll('"', "”")
    .replaceAll("<", "＜")
    .replaceAll(">", "＞")
    .replaceAll("|", "｜");
}

/** `GAME_TITLES` の副題("～ ...")部分を除いた短いタイトル(例: "東方地霊殿")を取り出す。 */
function shortGameTitle(replayInfo: ReplayInfo): string {
  return GAME_TITLES[replayInfo.game].japaneseName;
}

/**
 * 動画の役割。**解像度ではなく役割で区別する**——`delivery`が常に720pとは限らない
 * ため（720pに満たない録画だけ引き上げ、th20の1280x960はそのまま。`worker/convert.py`）。
 *
 * - `delivery`: ユーザーへ渡す本命。ウォーターマークが合成されている
 * - `raw`: 録画そのままの版。解像度が実際に変わる録画でのみ副次リンクとして併せて提供する
 */
export type VideoVariant = "delivery" | "raw";

/**
 * 動画ダウンロード時のファイル名を組み立てる。
 * 例: "東方地霊殿 Lunatic 霊夢A 442,469,780 (プレイヤー koyi) #TouhouSattori.mp4"
 * リプレイ解析情報が欠けている項目は省く（`replayInfo`自体が無ければjobIdのみで組み立てる）。
 */
export function buildDownloadFilename(
  jobId: string,
  replayInfo: ReplayInfo | null,
  variant: VideoVariant,
): string {
  if (!replayInfo) {
    return `${jobId} ${HASHTAG}.mp4`;
  }

  const headline = [
    shortGameTitle(replayInfo),
    replayInfo.difficulty,
    replayInfo.character,
    replayInfo.score === null ? null : replayInfo.score.toLocaleString("ja-JP"),
  ]
    .filter((part): part is string => Boolean(part))
    .join(" ");

  const player = replayInfo.player ? ` (プレイヤー ${replayInfo.player})` : "";
  const variantSuffix = variant === "raw" ? " #raw" : "";

  return sanitizeFilename(`${headline}${player}${variantSuffix} ${HASHTAG}.mp4`);
}

/**
 * RFC 5987 のパーセントエンコードを行う（`filename*`の値部分用）。
 * `encodeURIComponent` は非ASCII文字をUTF-8バイト列としてパーセントエンコードして
 * くれるが、`! ' ( ) *` は未エスケープのまま残す。このうち `' ( ) *` はRFC 5987の
 * attr-char（percent-encode不要な文字集合）に含まれないため、追加で手動エンコードする
 * （過剰エンコードになる文字はあっても、パーサー側は通常のパーセントデコードで
 * 復元できるため互換性上の問題は無い）。
 */
function encodeRfc5987ValueChars(value: string): string {
  return encodeURIComponent(value)
    .replaceAll("'", "%27")
    .replaceAll("(", "%28")
    .replaceAll(")", "%29")
    .replaceAll("*", "%2A");
}

/**
 * `Content-Disposition` ヘッダー値を組み立てる（RFC 6266 / RFC 5987 準拠）。
 * S3の GetObject API は `response-content-disposition` クエリパラメータの値を
 * そのままこのヘッダーとしてエコーバックするため、CloudFront経由の動画ダウンロード
 * URLにこの値をクエリとして付与することで、ブラウザ標準のダウンロード機構
 * （進捗表示・バックグラウンド継続・ディスクへの直接ストリーミング）を使わせられる
 * （JSでのfetch+Blob化が不要になる）。
 * 非ASCII文字（日本語ファイル名）を解釈しない古いUA向けに、ASCIIのみへ置換した
 * `filename` もフォールバックとして併記する。
 */
export function buildContentDispositionValue(filename: string): string {
  const asciiFallback = filename.replaceAll('"', "'").replace(/[^\x20-\x7E]/g, "_");
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeRfc5987ValueChars(filename)}`;
}

/**
 * 出力バケットのライフサイクルルール（`OUTPUT_RETENTION_DAYS`日で自動削除）に基づく
 * ダウンロード期限を算出する。起点は動画アップロード時刻そのものではなく `doneAt`
 * （status "done" 遷移時刻、ほぼ同時刻に確定する）。`doneAt` 未設定（旧ジョブ・
 * 未完了）なら null。ジョブ画面（`apps/api/src/handlers/getJob.ts`）と完了メール
 * （`apps/api/src/ses.ts`）の両方で同じ値を表示するために共有する。
 */
export function calculateDownloadExpiresAt(doneAt: string | null): string | null {
  if (!doneAt) {
    return null;
  }
  const expiresAt = new Date(doneAt);
  expiresAt.setUTCDate(expiresAt.getUTCDate() + OUTPUT_RETENTION_DAYS);
  return expiresAt.toISOString();
}
