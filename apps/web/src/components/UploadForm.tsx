import { useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import {
  defaultSlowMotionFor,
  EMAIL_PATTERN,
  GAME_TITLES,
  isSupportedGame,
  parseReplayInfo,
  SLOW_MOTION_CAPABILITY,
  SUPPORTED_GAME_IDS,
  supportsEc2SlowMotion,
  supportsHighResolutionRecording,
  supportsSlowMotion,
  supportsTh10BugfixMarisaB,
} from "@sattori/shared";
import { trackParseError } from "../api/analytics.ts";
import {
  createUpload,
  getWorkerAvailability,
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

export function UploadForm() {
  const { t, i18n } = useTranslation();
  const locale = useLocale();
  /**
   * STEP1〜3の入力・解析結果は`Layout`直下（`App.tsx`）で保持する。`/replay-help`や
   * `/terms`へのリンクで離脱してブラウザの「戻る」で戻ってきても消えないようにする
   * ため（`UploadFormStateContext.ts`）。`dragging`・`errorMessage`・
   * `slowMotionAvailable`は一時的なUI状態／マウントの度に取り直す情報なのでここでは
   * 対象外——ローカルの`useState`のままにする。
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
    slowMotionTouched,
    setSlowMotionTouched,
    slowMotion,
    setSlowMotion,
    th10BugfixMarisaB,
    setTh10BugfixMarisaB,
    th06ncHighResolution,
    setTh06ncHighResolution,
  } = useUploadFormState();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  /**
   * 低速録画（Issue #68）が今選べるか。自宅ワーカー（Issue #49）が
   * `slow-motion-recording` を宣言して空いているときだけ true になる。
   * 取得に失敗した場合も false のまま——選択肢を出しておいて実際には等倍で
   * 録画される、という食い違いを避け、安全側（グレーアウト）に倒す。
   */
  const [slowMotionAvailable, setSlowMotionAvailable] = useState(false);

  const busy = phase !== "idle" && phase !== "ready";
  const emailValid = EMAIL_PATTERN.test(email);
  const game = preview?.game ?? null;
  // 低速録画に対応したタイトルか（Issue #101）。非対応タイトルで要求すると、ゲームは
  // 等倍で動くのに後処理だけが等倍化を行って2倍速の動画が出来上がるため、可否とは
  // 別にここで塞ぐ。タイトル未確定（解析前）も非対応として扱う。
  const slowMotionSupported = supportsSlowMotion(game);
  const ec2SlowMotionSupported = supportsEc2SlowMotion(game);
  // 低速録画は「対応タイトル」かつ「自宅ワーカーまたはEC2で利用可能」な場合に有効（Issue #245）。
  // 可否が変わった／別タイトルのリプレイに差し替えられた場合に、実際に送信される値が
  // 取り残されないよう、「チェック状態」ではなくこの導出値を唯一の真実として扱う。
  const isSlowMotionAvailable = slowMotionAvailable || ec2SlowMotionSupported;
  const slowMotionSelectable = isSlowMotionAvailable && slowMotionSupported;
  const slowMotionChecked = slowMotionSelectable && slowMotion;
  // 選べない理由はユーザーから見て意味が違う（タイトル側の未対応は待っても変わらないが、
  // ワーカーの混雑は時間をおけば変わる）ので区別して出す。タイトルが未確定の間は
  // 「まだリプレイを選んでいない」だけなので、非対応とは言わない。
  const slowMotionHint =
    preview && !slowMotionSupported
      ? t("uploadForm.slowMotionUnsupportedGame")
      : isSlowMotionAvailable
        ? t("uploadForm.slowMotionHintLine2")
        : t("uploadForm.slowMotionUnavailable");

  // th10「バグマリ」修正オプション(Issue #75)。バグの発生条件(魔理沙Bのショット
  // 火力パワー3依存)自体が対象を規定するため、低速録画と異なりワーカーの空き状況には
  // 依存しない——「th10かつ魔理沙B」の組み合わせだけで選択可否が決まる。
  const th10BugfixMarisaBSelectable = supportsTh10BugfixMarisaB(
    preview?.game ?? null,
    preview?.character ?? null,
  );
  const th10BugfixMarisaBChecked = th10BugfixMarisaBSelectable && th10BugfixMarisaB;

  // 1080p録画オプション(Issue #241)。th06nc(GPU描画必須)限定で選べる。既定は720p。
  const th06ncHighResolutionSelectable = supportsHighResolutionRecording(preview?.game ?? null);
  const th06ncHighResolutionChecked = th06ncHighResolutionSelectable && th06ncHighResolution;

  // 自宅ワーカーの空き状況はページ表示時に1回だけ取得する。実際に録画が始まるのは
  // ユーザーがマジックリンクを開いた後（最大24時間後）で、その時点の可否とは
  // どのみち一致しないため、ポーリングして精度を上げても意味がない。
  useEffect(() => {
    let cancelled = false;
    getWorkerAvailability()
      .then((availability) => {
        if (!cancelled) {
          setSlowMotionAvailable(
            availability.available && availability.capabilities.includes(SLOW_MOTION_CAPABILITY),
          );
        }
      })
      .catch(() => {
        // 低速録画が選べないだけで、アップロード自体は問題なく続けられる。
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // タイトルが確定した（＝リプレイを解析できた）時点で、そのタイトルの既定へ寄せる。
  useEffect(() => {
    if (!slowMotionTouched) {
      setSlowMotion(defaultSlowMotionFor(preview?.game ?? null, slowMotionAvailable));
    }
  }, [preview?.game, slowMotionAvailable, slowMotionTouched]);

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
          slowMotion: slowMotionChecked,
          th10BugfixMarisaB: th10BugfixMarisaBChecked,
          th06ncHighResolution: th06ncHighResolutionChecked,
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
        - 等倍録画では品質が落ちる: 低速録画（Issue #68）が使えないときのみ該当するため、
          自宅ワーカーが空いていて低速録画が選べる状態なら出さない。
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
            <li>
              {t("uploadForm.th20NoticeFrameDrop")}
              {!slowMotionChecked && t("uploadForm.th20NoticeNormalSpeed")}
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
              {t("uploadForm.watermarkHintLine1")}<br/>
              {t("uploadForm.watermarkHintLine2")}
            </small>
          </span>
        </label>
        {/*
          低速録画（Issue #68）。ゲームを1/2倍速で動かして録画し、後処理で等倍へ戻す。
          録画に実時間で倍かかるためEC2では行わず、電気代しかかからない自宅ワーカー
          （Issue #49）が空いているときにだけ選べる。使えない間はグレーアウトし、
          その理由をヒントに出す（黙って消すと「前は在ったのに」と混乱するため）。
        */}
        <label
          className={clsx(styles.option, !slowMotionSelectable && styles.optionDisabled)}
        >
          <input
            type="checkbox"
            checked={slowMotionChecked}
            onChange={(e) => {
              setSlowMotionTouched(true);
              setSlowMotion(e.target.checked);
            }}
            disabled={busy || !slowMotionSelectable}
          />
          <span>
            {t("uploadForm.slowMotionOption")}
            <small className={styles.optionHint}>
              {t("uploadForm.slowMotionHintLine1")}<br/>
              <span className={styles.slowMotionHint}>{slowMotionHint}</span>
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
        {/*
          1080p録画オプション(Issue #241)。th06nc(東方紅魔郷: New Classic、GPU描画必須)
          限定。720p/1080pどちらもインスタンスはg6f.xlargeのまま提供する
          (docs/decisions/0046)ため、ワーカーの空き状況には依存しない。
        */}
        <label
          className={clsx(styles.option, !th06ncHighResolutionSelectable && styles.optionDisabled)}
        >
          <input
            type="checkbox"
            checked={th06ncHighResolutionChecked}
            onChange={(e) => setTh06ncHighResolution(e.target.checked)}
            disabled={busy || !th06ncHighResolutionSelectable}
          />
          <span>
            {t("uploadForm.th06ncHighResolutionOption")}
            <small className={styles.optionHint}>
              {th06ncHighResolutionSelectable
                ? t("uploadForm.th06ncHighResolutionHintLine1")
                : t("uploadForm.th06ncHighResolutionUnsupportedGame")}
            </small>
          </span>
        </label>
      </details>

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
