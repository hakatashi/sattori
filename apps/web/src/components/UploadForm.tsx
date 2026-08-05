import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { DEFAULT_RECORDING_OPTIONS, EMAIL_PATTERN, type ReplayInfo } from "@sattori/shared";
import {
  createUpload,
  parseReplay,
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
 * uploading/parsing: ファイル選択直後に自動で走る署名URL取得→PUT→解析。
 * ready: 解析成功。プレビュー表示中で「次のステップ」が押せる。
 * starting: 「次のステップ」押下後、録画ジョブを起動中。
 */
type Phase = "idle" | "uploading" | "parsing" | "ready" | "starting";

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
    supported: false,
    icon: 'th20.png',
  },
];

function formatFileSize(bytes: number): string {
  return `${(bytes / 1024).toFixed(2)}KB`;
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

  const busy = phase !== "idle" && phase !== "ready";
  const emailValid = EMAIL_PATTERN.test(email);

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

  /** ファイル選択直後に自動でアップロード＆解析し、成功したらプレビューを表示する。 */
  async function uploadAndParse(selected: File) {
    try {
      setPhase("uploading");
      const upload = await createUpload({ filename: selected.name, size: selected.size });
      await uploadReplay(upload.uploadUrl, selected);

      setPhase("parsing");
      const info = await parseReplay(upload.replayKey);

      setReplayKey(upload.replayKey);
      setPreview(info);
      setPhase("ready");
    } catch (err) {
      const message =
        err instanceof SattoriApiError ? err.message : t("uploadForm.unexpectedError");
      setErrorMessage(message);
      setFile(null);
      setPhase("idle");
    }
  }

  async function handleSubmit() {
    if (!replayKey || phase !== "ready" || !emailValid) {
      return;
    }
    setErrorMessage(null);
    try {
      setPhase("starting");
      await requestMagicLink(replayKey, { watermark }, email, locale, preview);
      onMagicLinkSent(email);
    } catch (err) {
      const message =
        err instanceof SattoriApiError ? err.message : t("uploadForm.unexpectedError");
      setErrorMessage(message);
      setPhase("ready");
    }
  }

  function renderPreview() {
    if (phase === "uploading") {
      return <ReplayPreview status="loading" label={t("uploadForm.uploading")} />;
    }
    if (phase === "parsing") {
      return <ReplayPreview status="loading" label={t("uploadForm.parsing")} />;
    }
    if (preview) {
      return <ReplayPreview status="ready" info={preview} />;
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

      {errorMessage && <p className={styles.error}>{errorMessage}</p>}

      <p className={clsx(styles.stepLabel, styles.stepLabelSecondary)}>
        <span className={styles.stepNumber}>STEP 2</span>
        {t("uploadForm.step2Label")}
      </p>
      {renderPreview()}

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
