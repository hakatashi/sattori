import { GAME_TITLES, type ReplayInfo } from "@sattori/shared";
import styles from "./ReplayPreview.module.css";

interface Props {
  info: ReplayInfo;
}

/** 秒数を「◯分◯◯秒」形式にする（推定収録時間の表示用）。 */
export function formatDuration(seconds: number | null): string {
  if (seconds === null) {
    return "不明";
  }
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return `${minutes}分${remaining.toString().padStart(2, "0")}秒`;
}

function formatScore(score: number | null): string {
  return score === null ? "不明" : score.toLocaleString("ja-JP");
}

function formatCleared(cleared: boolean | null): string {
  if (cleared === null) {
    return "不明";
  }
  return cleared ? "クリア" : "未クリア";
}

/** ページAの解析プレビュー（Issue #8）。アップロード直後に解析したリプレイの内容を表示する。 */
export function ReplayPreview({ info }: Props) {
  return (
    <section className={styles.preview} aria-label="リプレイ解析結果">
      <div className={styles.headline}>
        <img className={styles.icon} src={`/icons/${info.game}.png`} alt="" />
        <p className={styles.title}>{GAME_TITLES[info.game]}</p>
      </div>
      <dl className={styles.details}>
        <div className={styles.row}>
          <dt>使用キャラ</dt>
          <dd>{info.character ?? "不明"}</dd>
        </div>
        <div className={styles.row}>
          <dt>難易度</dt>
          <dd>{info.difficulty ?? "不明"}</dd>
        </div>
        <div className={styles.row}>
          <dt>到達ステージ</dt>
          <dd>{info.stage ?? "不明"}</dd>
        </div>
        <div className={styles.row}>
          <dt>スコア</dt>
          <dd>{formatScore(info.score)}</dd>
        </div>
        <div className={styles.row}>
          <dt>記録日時</dt>
          <dd>{info.date ?? "不明"}</dd>
        </div>
        <div className={styles.row}>
          <dt>クリア</dt>
          <dd>{formatCleared(info.cleared)}</dd>
        </div>
        <div className={styles.row}>
          <dt>収録時間（目安）</dt>
          <dd>{formatDuration(info.estimatedDurationSeconds)}</dd>
        </div>
      </dl>
    </section>
  );
}
