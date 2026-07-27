import { GAME_TITLES } from "./games.js";
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
  return GAME_TITLES[replayInfo.game].split(" ～ ")[0] ?? GAME_TITLES[replayInfo.game];
}

/**
 * 動画ダウンロード時のファイル名を組み立てる。
 * 例: "東方地霊殿 Lunatic 霊夢A 442,469,780 (プレイヤー koyi) #TouhouSattori.mp4"
 * リプレイ解析情報が欠けている項目は省く（`replayInfo`自体が無ければjobIdのみで組み立てる）。
 */
export function buildDownloadFilename(
  jobId: string,
  replayInfo: ReplayInfo | null,
  variant: "720p" | "original",
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
  const resolutionSuffix = variant === "original" ? " #raw" : "";

  return sanitizeFilename(`${headline}${player}${resolutionSuffix} ${HASHTAG}.mp4`);
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
