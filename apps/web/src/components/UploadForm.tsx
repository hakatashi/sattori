import { useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import {
  DEFAULT_RECORDING_OPTIONS,
  defaultSlowMotionFor,
  EMAIL_PATTERN,
  parseReplayInfo,
  SLOW_MOTION_CAPABILITY,
  supportsSlowMotion,
  type ReplayInfo,
} from "@sattori/shared";
import {
  createUpload,
  getWorkerAvailability,
  requestMagicLink,
  SattoriApiError,
  uploadReplay,
} from "../api/client.ts";
import { useLocale } from "../i18n/LocaleContext.ts";
import { toLocalizedPath } from "../i18n/paths.ts";
import { ReplayPreview } from "./ReplayPreview.tsx";
import styles from "./UploadForm.module.css";
import clsx from "clsx";

interface Props {
  onMagicLinkSent: (email: string) => void;
}

/**
 * idle: 未選択、または直前の選択がエラーで終わった状態。
 * processing: ファイル選択直後に自動で走る、ブラウザ内解析（`@sattori/touhou-replay-parser`
 *   を`@sattori/shared`経由で直接呼ぶ）とS3アップロード（署名URL取得→PUT）を並行実行中。
 *   解析はアップロード完了を待たずに終わるため、`preview`はこのフェーズの途中で
 *   先に埋まりうる（`renderPreview`参照）。
 * ready: 解析・アップロードともに完了。プレビュー表示中で「次のステップ」が押せる。
 * starting: 「次のステップ」押下後、録画ジョブを起動中。
 */
type Phase = "idle" | "processing" | "ready" | "starting";

const gameTitles = [
  {
    japanese: "東方紅魔郷",
    english: "Embodiment of\nScarlet Devil",
    shortName: "EoSD",
    supported: true,
    icon: 'th06.png',
  },
  {
    japanese: "東方妖々夢",
    english: "Perfect Cherry\nBlossom",
    shortName: "PCB",
    supported: true,
    icon: 'th07.png',
  },
  {
    japanese: "東方永夜抄",
    english: "Imperishable Night",
    shortName: "IN",
    supported: true,
    icon: 'th08.png',
  },
  {
    japanese: "東方花映塚",
    english: "Phantasmagoria of\nFlower View",
    shortName: "PoFV",
    supported: false,
    icon: 'th09.png',
  },
  {
    japanese: "東方文花帖",
    english: "Shoot the Bullet",
    shortName: "StB",
    supported: false,
    icon: 'th095.png',
  },
  {
    japanese: "東方風神録",
    english: "Mountain of Faith",
    shortName: "MoF",
    supported: false,
    icon: 'th10.png',
  },
  {
    japanese: "東方地霊殿",
    english: "Subterranean\nAnimism",
    shortName: "SA",
    supported: true,
    icon: 'th11.png',
  },
  {
    japanese: "東方星蓮船",
    english: "Undefined\nFantastic Object",
    shortName: "UFO",
    supported: false,
    icon: 'th12.png',
  },
  {
    japanese: "ダブルスポイラー",
    english: "Double Spoiler",
    shortName: "DS",
    supported: false,
    icon: 'th125.png',
  },
  {
    japanese: "妖精大戦争",
    english: "Fairy Wars",
    shortName: "GFW",
    supported: false,
    icon: 'th128.png',
  },
  {
    japanese: "東方神霊廟",
    english: "Ten Desires",
    shortName: "TD",
    supported: false,
    icon: 'th13.png',
  },
  {
    japanese: "東方輝針城",
    english: "Double Dealing\nCharacter",
    shortName: "DDC",
    supported: false,
    icon: 'th14.png',
  },
  {
    japanese: "弾幕アマノジャク",
    english: "Impossible\nSpell Card",
    shortName: "ISC",
    supported: false,
    icon: 'th14.png',
  },
  {
    japanese: "東方紺珠伝",
    english: "Legacy of\nLunatic Kingdom",
    shortName: "LoLK",
    supported: false,
    icon: 'th15.png',
  },
  {
    japanese: "東方天空璋",
    english: "Hidden Star in\nFour Seasons",
    shortName: "HSiFS",
    supported: false,
    icon: 'th16.png',
  },
  {
    japanese: "秘封ナイトメア\nダイアリー",
    english: "Violet Detector",
    shortName: "VD",
    supported: false,
    icon: 'th165.png',
  },
  {
    japanese: "東方鬼形獣",
    english: "Wily Beast and\nWeakest Creature",
    shortName: "WBaWC",
    supported: false,
    icon: 'th17.png',
  },
  {
    japanese: "東方虹龍洞",
    english: "Unconnected\nMarketeers",
    shortName: "UM",
    supported: false,
    icon: 'th18.png',
  },
  {
    japanese: "東方錦上京",
    english: "Fossilized Wonders",
    shortName: "FW",
    supported: true,
    icon: 'th20.png',
  },
];

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

export function UploadForm({ onMagicLinkSent }: Props) {
  const { t, i18n } = useTranslation();
  const locale = useLocale();
  const [file, setFile] = useState<File | null>(null);
  const [replayKey, setReplayKey] = useState<string | null>(null);
  const [preview, setPreview] = useState<ReplayInfo | null>(null);
  const [watermark, setWatermark] = useState(DEFAULT_RECORDING_OPTIONS.watermark);
  const [email, setEmail] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  /**
   * 低速録画（Issue #68）が今選べるか。自宅ワーカー（Issue #49）が
   * `slow-motion-recording` を宣言して空いているときだけ true になる。
   * 取得に失敗した場合も false のまま——選択肢を出しておいて実際には等倍で
   * 録画される、という食い違いを避け、安全側（グレーアウト）に倒す。
   */
  const [slowMotionAvailable, setSlowMotionAvailable] = useState(false);
  /**
   * ユーザーが低速録画のチェックを手で動かしたか。動かしていない間は
   * タイトルごとの既定（th20のみオン）に追従させ、一度でも触ったらその意思を尊重する。
   */
  const [slowMotionTouched, setSlowMotionTouched] = useState(false);
  const [slowMotion, setSlowMotion] = useState(false);

  const busy = phase !== "idle" && phase !== "ready";
  const emailValid = EMAIL_PATTERN.test(email);
  // 低速録画に対応したタイトルか（Issue #101）。非対応タイトルで要求すると、ゲームは
  // 等倍で動くのに後処理だけが等倍化を行って2倍速の動画が出来上がるため、可否とは
  // 別にここで塞ぐ。タイトル未確定（解析前）も非対応として扱う。
  const slowMotionSupported = supportsSlowMotion(preview?.game ?? null);
  // 低速録画は「対応タイトル」かつ「自宅ワーカーが使える」場合に限り有効。可否が
  // 変わった／別タイトルのリプレイに差し替えられた場合に、実際に送信される値が
  // 取り残されないよう、「チェック状態」ではなくこの導出値を唯一の真実として扱う。
  const slowMotionSelectable = slowMotionAvailable && slowMotionSupported;
  const slowMotionChecked = slowMotionSelectable && slowMotion;
  // 選べない理由はユーザーから見て意味が違う（タイトル側の未対応は待っても変わらないが、
  // ワーカーの混雑は時間をおけば変わる）ので区別して出す。タイトルが未確定の間は
  // 「まだリプレイを選んでいない」だけなので、非対応とは言わない。
  const slowMotionHint =
    preview && !slowMotionSupported
      ? t("uploadForm.slowMotionUnsupportedGame")
      : slowMotionAvailable
        ? t("uploadForm.slowMotionHintLine2")
        : t("uploadForm.slowMotionUnavailable");

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
        setErrorMessage(result.error.message);
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
        err instanceof SattoriApiError ? err.message : t("uploadForm.unexpectedError");
      setErrorMessage(message);
      return false;
    }
  }

  async function handleSubmit() {
    if (!replayKey || phase !== "ready" || !emailValid) {
      return;
    }
    setErrorMessage(null);
    try {
      setPhase("starting");
      await requestMagicLink(
        replayKey,
        { watermark, slowMotion: slowMotionChecked },
        email,
        locale,
        preview,
      );
      onMagicLinkSent(email);
    } catch (err) {
      const message =
        err instanceof SattoriApiError ? err.message : t("uploadForm.unexpectedError");
      setErrorMessage(message);
      setPhase("ready");
    }
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

  return (
    <section className={styles.card}>
      <p className={styles.supportedTitlesLabel}>
        {t("uploadForm.supportedTitlesLabel", {
          count: gameTitles.filter((title) => title.supported).length,
        })}
      </p>
      <ul className={styles.supportedTitles}>
        {gameTitles.map((title) => {
          const fullName = isEnglish ? title.english : title.japanese;
          return (
            <li key={title.shortName} className={clsx(styles.supportedTitle, title.supported && styles.supported)}>
              <img src={`/icons/${title.icon}`} alt={fullName} className={styles.supportedTitleIcon} />
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
          </>}
        </span>
      </label>

      <p className={styles.replayHelpLink}>
        <Link to={toLocalizedPath("/replay-help", locale)}>{t("uploadForm.replayHelpLink")}</Link>
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
