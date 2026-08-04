import clsx from "clsx";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
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
export function formatDuration(seconds: number | null, t: TFunction): string {
  if (seconds === null) {
    return t("replayPreview.unknown");
  }
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return t("replayPreview.durationFormat", { minutes, seconds: remaining.toString().padStart(2, "0") });
}

function formatScore(score: number | null, t: TFunction, locale: string): string {
  return score === null ? t("replayPreview.unknown") : score.toLocaleString(locale);
}

function formatCleared(cleared: boolean | null, t: TFunction): string {
  if (cleared === null) {
    return t("replayPreview.unknown");
  }
  return cleared ? t("replayPreview.cleared") : t("replayPreview.notCleared");
}

/**
 * 表示言語に応じたローカライズ済みキャラ名（`characterNameJa`/`characterNameEn`、
 * `@sattori/touhou-replay-parser` の `localizeCharacterName` 由来）を優先し、
 * 未知の形式などで取得できない場合は生の `character` にフォールバックする。
 */
function displayCharacter(info: ReplayInfo, language: string): string | null {
  const localized = language === "en" ? info.characterNameEn : info.characterNameJa;
  return localized ?? info.character;
}

/**
 * ページAの解析プレビュー（Issue #8）。STEP1のファイル選択と同時にSTEP2として常に表示し、
 * 状態に応じてプレースホルダー／読み込み中スピナー／解析結果を切り替える。
 */
export function ReplayPreview(props: Props) {
  const { t, i18n } = useTranslation();

  if (props.status === "empty") {
    return (
      <section className={clsx(styles.preview, styles.placeholder)} aria-label={t("replayPreview.ariaLabel")}>
        <p className={styles.placeholderText}>{t("replayPreview.emptyPlaceholder")}</p>
      </section>
    );
  }

  if (props.status === "loading") {
    return (
      <section className={clsx(styles.preview, styles.placeholder)} aria-label={t("replayPreview.ariaLabel")}>
        <span className={styles.spinner} role="status" aria-label={t("replayPreview.loadingAriaLabel")} />
        <p className={styles.placeholderText}>{props.label}</p>
      </section>
    );
  }

  const { info } = props;
  return (
    <section className={styles.preview} aria-label={t("replayPreview.ariaLabel")}>
      <div className={styles.headline}>
        <img className={styles.icon} src={`/icons/${info.game}.png`} alt="" />
        <p className={styles.title}>{GAME_TITLES[info.game]}</p>
        <div className={clsx(styles.difficultyBadge, info.difficulty ? styles[info.difficulty.toLowerCase()] : undefined)}>
          {info.difficulty ?? t("replayPreview.unknown")}
        </div>
      </div>
      <div className={styles.basicInfo}>
        <div className={styles.character}>
          {displayCharacter(info, i18n.language) ?? t("replayPreview.unknown")}
        </div>
        <div className={styles.score}>
          {formatScore(info.score, t, i18n.language)}
        </div>
      </div>
      <dl className={styles.details}>
        <div className={styles.row}>
          <dt>{t("replayPreview.player")}</dt>
          <dd>{info.player ?? t("replayPreview.unknown")}</dd>
        </div>
        {info.stage !== null && (
          <div className={styles.row}>
            <dt>{t("replayPreview.stage")}</dt>
            <dd>{info.stage}</dd>
          </div>
        )}
        <div className={styles.row}>
          <dt>{t("replayPreview.date")}</dt>
          <dd>{info.date ?? t("replayPreview.unknown")}</dd>
        </div>
        {info.cleared !== null && (
          <div className={styles.row}>
            <dt>{t("replayPreview.clearedLabel")}</dt>
            <dd>{formatCleared(info.cleared, t)}</dd>
          </div>
        )}
        <div className={styles.row}>
          <dt>{t("replayPreview.duration")}</dt>
          <dd>{formatDuration(info.estimatedDurationSeconds, t)}</dd>
        </div>
      </dl>
    </section>
  );
}
