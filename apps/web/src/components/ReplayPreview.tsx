import clsx from "clsx";
import { GAME_TITLES, type ReplayInfo } from "@sattori/shared";
import styles from "./ReplayPreview.module.css";

type Props =
  /** ファイル未選択（STEP2はSTEP1と同時に表示するため、選択前もこの状態で表示する）。 */
  | { status: "empty" }
  /** アップロード中・解析中。 */
  | { status: "loading"; label: string }
  /** 解析成功。 */
  | { status: "ready"; info: ReplayInfo };

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

/**
 * ページAの解析プレビュー（Issue #8）。STEP1のファイル選択と同時にSTEP2として常に表示し、
 * 状態に応じてプレースホルダー／読み込み中スピナー／解析結果を切り替える。
 */
export function ReplayPreview(props: Props) {
  if (props.status === "empty") {
    return (
      <section className={clsx(styles.preview, styles.placeholder)} aria-label="リプレイ解析結果">
        <p className={styles.placeholderText}>リプレイファイルを選択すると、ここに内容が表示されます</p>
      </section>
    );
  }

  if (props.status === "loading") {
    return (
      <section className={clsx(styles.preview, styles.placeholder)} aria-label="リプレイ解析結果">
        <span className={styles.spinner} role="status" aria-label="読み込み中" />
        <p className={styles.placeholderText}>{props.label}</p>
      </section>
    );
  }

  const { info } = props;
  return (
    <section className={styles.preview} aria-label="リプレイ解析結果">
      <div className={styles.headline}>
        <img className={styles.icon} src={`/icons/${info.game}.png`} alt="" />
        <p className={styles.title}>{GAME_TITLES[info.game]}</p>
      </div>
      <dl className={styles.details}>
        <div className={styles.row}>
          <dt>プレイヤー名</dt>
          <dd>{info.player ?? "不明"}</dd>
        </div>
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
