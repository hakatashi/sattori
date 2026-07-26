import { GAME_TITLES, type ReplayInfo } from "@sattori/shared";

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
  const resolutionSuffix = variant === "original" ? " (オリジナル解像度)" : "";

  return sanitizeFilename(`${headline}${player}${resolutionSuffix} ${HASHTAG}.mp4`);
}
