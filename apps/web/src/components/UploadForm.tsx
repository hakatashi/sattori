import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import {
  EMAIL_PATTERN,
  estimateRecordingCompletionSeconds,
  GAME_TITLES,
  isGpuStep,
  isSupportedGame,
  parseReplayInfo,
  recordingPlanFor,
  recordingSpeedForStep,
  SUPPORTED_GAME_IDS,
  supportsTh10BugfixMarisaB,
  type GameId,
} from "@sattori/shared";
import { trackParseError } from "../api/analytics.ts";
import {
  createUpload,
  requestMagicLink,
  SattoriApiError,
  uploadReplay,
} from "../api/client.ts";
import { translateApiErrorMessage, translateUnsupportedGameMessage } from "../i18n/apiErrors.ts";
import { useLocale } from "../i18n/LocaleContext.ts";
import { toLocalizedPath } from "../i18n/paths.ts";
import { MagicLinkSent } from "./MagicLinkSent.tsx";
import { ReplayPreview } from "./ReplayPreview.tsx";
import { useUploadFormState } from "./UploadFormStateContext.ts";
import styles from "./UploadForm.module.css";
import clsx from "clsx";
import { helpCircleOutline, warningOutline } from "ionicons/icons";

function formatFileSize(bytes: number): string {
  return `${(bytes / 1024).toFixed(2)}KB`;
}

/**
 * `File.prototype.arrayBuffer()`ではなく`FileReader`を使う。テスト環境(jsdom)を含め、
 * より幅広い環境で確実に動くのはこちらのため。
 */
function readFileAsArrayBuffer(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

/**
 * 録画完了までの推定時間（分）。リプレイの尺が分からなければ null。録画の段（`recordingPlan.ts`）の
 * 最初の段で録れたときの値で、待ち行列での待ち時間や、混雑で後の段へ進んだときの延びは含まない
 * （`estimateRecordingCompletionSeconds()`）。
 */
function estimatedCompletionMinutes(
  game: GameId,
  difficulty: string | null | undefined,
  durationSeconds: number | null | undefined,
): number | null {
  const first = recordingPlanFor(game)[0];
  if (durationSeconds === null || durationSeconds === undefined || first === undefined) {
    return null;
  }
  const speed = recordingSpeedForStep(first, { replayInfo: { difficulty: difficulty ?? null } });
  const seconds = estimateRecordingCompletionSeconds(durationSeconds, speed, isGpuStep(first));
  return Math.max(1, Math.round(seconds / 60));
}

export function UploadForm() {
  const { t, i18n } = useTranslation();
  const locale = useLocale();
  /**
   * STEP1〜3の入力・解析結果は`Layout`直下（`App.tsx`）で保持する。`/replay-help`や
   * `/terms`へのリンクで離脱してブラウザの「戻る」で戻ってきても消えないようにする
   * ため（`UploadFormStateContext.ts`）。`dragging`・`errorMessage`は
   * 一時的なUI状態なのでここでは対象外——ローカルの`useState`のままにする。
   */
  const {
    file,
    setFile,
    replayKey,
    setReplayKey,
    preview,
    setPreview,
    watermark,
    setWatermark,
    email,
    setEmail,
    phase,
    setPhase,
    th10BugfixMarisaB,
    setTh10BugfixMarisaB,
  } = useUploadFormState();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const busy = phase !== "idle" && phase !== "ready";
  const emailValid = EMAIL_PATTERN.test(email);
  const game = preview?.game ?? null;
  // th10「バグマリ」修正オプション(Issue #75)。バグの発生条件(魔理沙Bのショット
  // 火力パワー3依存)自体が対象を規定するため、「th10かつ魔理沙B」の組み合わせだけで
  // 選択可否が決まる。
  const th10BugfixMarisaBSelectable = supportsTh10BugfixMarisaB(
    preview?.game ?? null,
    preview?.character ?? null,
  );
  const th10BugfixMarisaBChecked = th10BugfixMarisaBSelectable && th10BugfixMarisaB;

  // 録画速度はユーザーが選ばない（Issue #317）。目安の時間だけを出す。
  const estimatedMinutes =
    game !== null
      ? estimatedCompletionMinutes(game, preview?.difficulty, preview?.estimatedDurationSeconds)
      : null;

  function selectFile(selected: File | null) {
    setErrorMessage(null);
    setReplayKey(null);
    setPreview(null);
    if (!selected) {
      setFile(null);
      return;
    }
    if (!selected.name.toLowerCase().endsWith(".rpy")) {
      setFile(null);
      setErrorMessage(t("uploadForm.invalidFileExtension"));
      return;
    }
    setFile(selected);
    void uploadAndParse(selected);
  }

  function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    selectFile(event.target.files?.[0] ?? null);
  }

  function handleDragOver(event: React.DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    if (!busy) {
      setDragging(true);
    }
  }

  function handleDragLeave(event: React.DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setDragging(false);
  }

  function handleDrop(event: React.DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setDragging(false);
    if (busy) {
      return;
    }
    selectFile(event.dataTransfer.files[0] ?? null);
  }

  /**
   * ファイル選択直後に自動で走る、ブラウザ内解析とS3アップロードの並行実行。
   * `@sattori/touhou-replay-parser`はゼロ依存でブラウザでもそのまま動作するため、
   * バックエンドの`POST /replays/parse`（S3からの再取得を挟む分のラグが乗る）を
   * 待たずに、選択直後のファイルをその場で解析してプレビューへ反映する。
   * アップロードはそれとは独立に進み、`replayKey`が要るのは次のステップ（マジック
   * リンク送信要求）の時点なので、プレビュー表示はアップロード完了を待たない。
   */
  async function uploadAndParse(selected: File) {
    setPhase("processing");
    setReplayKey(null);
    setPreview(null);

    const [parseOk, uploadOk] = await Promise.all([
      parseLocally(selected),
      uploadToServer(selected),
    ]);

    if (parseOk && uploadOk) {
      setPhase("ready");
    } else {
      setFile(null);
      setPhase("idle");
    }
  }

  async function parseLocally(selected: File): Promise<boolean> {
    try {
      const data = new Uint8Array(await readFileAsArrayBuffer(selected));
      const result = parseReplayInfo(data);
      if (!result.ok) {
        const message =
          result.error.code === "unsupported_game"
            ? translateUnsupportedGameMessage(t, result.error.game ?? null, result.error.message)
            : translateApiErrorMessage(t, result.error.code, result.error.message);
        setErrorMessage(message);
        trackParseError(result.error.code, result.error.game ?? null);
        return false;
      }
      setPreview(result.info);
      return true;
    } catch {
      setErrorMessage(t("uploadForm.unexpectedError"));
      return false;
    }
  }

  async function uploadToServer(selected: File): Promise<boolean> {
    try {
      const upload = await createUpload({ filename: selected.name, size: selected.size });
      await uploadReplay(upload.uploadUrl, selected);
      setReplayKey(upload.replayKey);
      return true;
    } catch (err) {
      const message =
        err instanceof SattoriApiError
          ? translateApiErrorMessage(t, err.code, err.message, { status: err.status })
          : t("uploadForm.unexpectedError");
      setErrorMessage(message);
      return false;
    }
  }

  /** `replayKey`が既に手元にある前提でマジックリンク送信要求を投げる。 */
  async function submitMagicLink(): Promise<{ ok: true } | { ok: false; message: string }> {
    if (!replayKey) {
      return { ok: false, message: t("uploadForm.unexpectedError") };
    }
    try {
      await requestMagicLink(
        replayKey,
        {
          watermark,
          th10BugfixMarisaB: th10BugfixMarisaBChecked,
          // th06ncの1080p録画は廃止した（Issue #317）。APIも無視する。
          th06ncHighResolution: false,
        },
        email,
        locale,
      );
      return { ok: true };
    } catch (err) {
      const message =
        err instanceof SattoriApiError
          ? err.code === "unsupported_game"
            ? translateUnsupportedGameMessage(t, preview?.game ?? null, err.message)
            : translateApiErrorMessage(t, err.code, err.message, { status: err.status })
          : t("uploadForm.unexpectedError");
      return { ok: false, message };
    }
  }

  async function handleSubmit() {
    if (!replayKey || phase !== "ready" || !emailValid) {
      return;
    }
    setErrorMessage(null);
    setPhase("starting");
    const result = await submitMagicLink();
    if (result.ok) {
      setPhase("sent");
    } else {
      setErrorMessage(result.message);
      setPhase("ready");
    }
  }

  /** 「sent」画面の「アップロード画面に戻る」。ファイル・解析結果・`replayKey`は保持したまま入力フォームへ戻す。 */
  function handleBack() {
    setPhase("ready");
  }

  function renderPreview() {
    if (preview) {
      return <ReplayPreview status="ready" info={preview} />;
    }
    if (phase === "processing") {
      return <ReplayPreview status="loading" label={t("uploadForm.parsing")} />;
    }
    return <ReplayPreview status="empty" />;
  }

  const isEnglish = i18n.language.startsWith("en");

  if (phase === "sent") {
    return (
      <MagicLinkSent email={email} onBack={handleBack} />
    );
  }

  return (
    <section className={styles.card}>
      {/* サービス全体の一時的なお知らせ(現在はGPUインスタンス枯渇からの復旧)。不要になったら削除する。 */}
      <div className={clsx(styles.notice, styles.siteNotice)} role="note">
        <p className={styles.siteNoticeText}>
          {t("uploadForm.gpuOutageNotice")}
        </p>
      </div>
      <p className={styles.supportedTitlesLabel}>
        {t("uploadForm.supportedTitlesLabel", {
          count: SUPPORTED_GAME_IDS.length,
        })}
      </p>
      <ul className={styles.supportedTitles}>
        {Object.values(GAME_TITLES).map((title) => {
          const supported = isSupportedGame(title.id);
          const fullName = isEnglish ? title.englishHyphenatedName : title.japaneseName;
          return (
            <li key={title.id} className={clsx(styles.supportedTitle, supported && styles.supported)}>
              <img src={`/icons/${title.id}.png`} alt={fullName} className={styles.supportedTitleIcon} />
              <span className={styles.supportedTitleName}>{fullName}</span>
            </li>
          );
        })}
      </ul>
      <p className={styles.stepLabel}>
        <span className={styles.stepNumber}>STEP 1</span>
        {t("uploadForm.step1Label")}
      </p>
      <label
        className={styles.dropzone}
        data-selected={file !== null}
        data-dragging={dragging}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <input
          type="file"
          accept=".rpy"
          className={styles.fileInput}
          onChange={handleFileChange}
          disabled={busy}
        />
        <span className={styles.dropzoneLabel}>
          {file ? `${file.name} (${formatFileSize(file.size)})` : <>
            <span className={styles.emphasisDropzone}>{t("uploadForm.dropzoneClick")}</span>
            {t("uploadForm.dropzoneRest")}
            <br/>
            {t("uploadForm.dropzoneOr")}
            <span className={styles.dropzoneNotice}>
              <ion-icon icon={warningOutline} className={styles.dropzoneNoticeIcon} aria-hidden="true" />
              {t("uploadForm.dropzoneOwnPlayNotice")}
            </span>
          </>}
        </span>
      </label>

      <p className={styles.replayHelpLink}>
        <Link to={toLocalizedPath("/replay-help", locale)}>
          <ion-icon icon={helpCircleOutline} className={styles.replayHelpLinkIcon} aria-hidden="true" />
          {t("uploadForm.replayHelpLink")}
        </Link>
      </p>

      {errorMessage && <p className={styles.error}>{errorMessage}</p>}

      <p className={clsx(styles.stepLabel, styles.stepLabelSecondary)}>
        <span className={styles.stepNumber}>STEP 2</span>
        {t("uploadForm.step2Label")}
      </p>
      {renderPreview()}
      {preview && phase === "processing" && (
        <small className={styles.optionHint}>{t("uploadForm.uploading")}</small>
      )}
      {/*
        th20固有の注意書き（Issue #87）。他タイトルには無い2つの既知の制約を、
        メールアドレスを入力して録画を依頼してしまう前に知らせる。
        - デシンク（リプレイずれ）が頻発する: リプレイファイル・ゲーム本体側の現象で、
          録画側では検知できない（touhou-recorder reports/45）。
          **ワーカーが録画時にthpracをアタッチするようになった後（Issue #105）も、この
          注意書きは消さないこと**。主因のANM再利用バグは「プレイ中」に発火し、それで
          汚染されたリプレイは再生側では原理的に修復できないため、「プレイ時にthpracを
          入れる」という案内はサーバー側の対策では代替できない（詳細は
          `apps/web/docs/upload-form.md`「ワーカーがthpracを適用した後もこの注意書きを残す理由」）。
      */}
      {preview?.game === "th20" && (
        <div className={styles.notice} role="note">
          <p className={styles.noticeTitle}>{t("uploadForm.th20NoticeTitle")}</p>
          <ul className={styles.noticeList}>
            <li>
              <Trans
                i18nKey="uploadForm.th20NoticeDesync"
                components={[
                  <a key="thprac" href="https://github.com/touhouworldcup/thprac" target="_blank" rel="noopener noreferrer"/>
                ]}
              />
            </li>
          </ul>
        </div>
      )}

      <p className={clsx(styles.stepLabel, styles.stepLabelSecondary)}>
        <span className={styles.stepNumber}>STEP 3</span>
        {t("uploadForm.step3Label")}
      </p>
      <input
        type="email"
        className={styles.emailInput}
        placeholder={t("uploadForm.emailPlaceholder")}
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        disabled={busy}
      />
      <small className={styles.optionHint}>{t("uploadForm.emailHint")}</small>

      <details className={styles.details}>
        <summary className={styles.summary}>{t("uploadForm.advancedSettings")}</summary>
        <label className={styles.option}>
          <input
            type="checkbox"
            checked={watermark}
            onChange={(e) => setWatermark(e.target.checked)}
            disabled={busy}
          />
          <span>
            {t("uploadForm.watermarkOption")}
            <small className={styles.optionHint}>
              {t("uploadForm.watermarkHintLine")}
            </small>
          </span>
        </label>
        {/*
          th10「バグマリ」修正オプション(Issue #75)。VsyncPatchの`BugFixTh10Power3`は
          記録リプレイと再生時で設定が食い違うとリプレイずれ(デシンク)を起こすが、
          リプレイファイル自体にはこの設定情報が含まれないため利用者の自己申告に頼る
          しかない(`worker/docs/titles/th10.md`)。バグの発生条件(魔理沙Bのショット
          火力パワー3依存)自体が対象を規定するため、「th10かつ魔理沙B」以外は
          グレーアウトする。
        */}
        <label
          className={clsx(styles.option, !th10BugfixMarisaBSelectable && styles.optionDisabled)}
        >
          <input
            type="checkbox"
            checked={th10BugfixMarisaBChecked}
            onChange={(e) => setTh10BugfixMarisaB(e.target.checked)}
            disabled={busy || !th10BugfixMarisaBSelectable}
          />
          <span>
            {t("uploadForm.th10BugfixMarisaBOption")}
            <small className={styles.optionHint}>
              {t("uploadForm.th10BugfixMarisaBHintLine1")}<br/>
              {th10BugfixMarisaBSelectable
                ? t("uploadForm.th10BugfixMarisaBHintLine2")
                : t("uploadForm.th10BugfixMarisaBUnsupportedGame")}
            </small>
          </span>
        </label>
      </details>

      {estimatedMinutes !== null && (
        <p className={styles.estimate}>{t("uploadForm.estimatedTime", { minutes: estimatedMinutes })}</p>
      )}
      <button
        type="button"
        className={styles.submit}
        onClick={handleSubmit}
        disabled={phase !== "ready" || !emailValid}
      >
        {phase === "starting" ? t("uploadForm.submitStarting") : t("uploadForm.submit")}
      </button>
      <small className={styles.termsAgreement}>
        <Trans
          i18nKey="uploadForm.termsAgreement"
          components={[<Link key="terms" to={toLocalizedPath("/terms", locale)} />]}
        />
      </small>
    </section>
  );
}
