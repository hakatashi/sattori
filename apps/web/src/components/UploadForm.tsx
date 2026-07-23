import { useState } from "react";
import { DEFAULT_RECORDING_OPTIONS, EMAIL_PATTERN, type ReplayInfo } from "@sattori/shared";
import {
  createUpload,
  parseReplay,
  requestMagicLink,
  SattoriApiError,
  uploadReplay,
} from "../api/client.ts";
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
    english: "EoSD",
    supported: false,
    icon: 'th06.png',
  },
  {
    japanese: "東方妖々夢",
    english: "PCB",
    supported: true,
    icon: 'th07.png',
  },
  {
    japanese: "東方永夜抄",
    english: "IN",
    supported: true,
    icon: 'th08.png',
  },
  {
    japanese: "東方花映塚",
    english: "PoFV",
    supported: false,
    icon: 'th09.png',
  },
  {
    japanese: "東方文花帖",
    english: "StB",
    supported: false,
    icon: 'th095.png',
  },
  {
    japanese: "東方風神録",
    english: "MoF",
    supported: false,
    icon: 'th10.png',
  },
  {
    japanese: "東方地霊殿",
    english: "SA",
    supported: false,
    icon: 'th11.png',
  },
  {
    japanese: "東方星蓮船",
    english: "UFO",
    supported: false,
    icon: 'th12.png',
  },
  {
    japanese: "ダブルスポイラー",
    english: "DS",
    supported: false,
    icon: 'th125.png',
  },
  {
    japanese: "妖精大戦争",
    english: "GFW",
    supported: false,
    icon: 'th128.png',
  },
  {
    japanese: "東方神霊廟",
    english: "TD",
    supported: false,
    icon: 'th13.png',
  },
  {
    japanese: "東方輝針城",
    english: "DDC",
    supported: false,
    icon: 'th14.png',
  },
  {
    japanese: "弾幕アマノジャク",
    english: "ISC",
    supported: false,
    icon: 'th14.png',
  },
  {
    japanese: "東方紺珠伝",
    english: "LoLK",
    supported: false,
    icon: 'th15.png',
  },
  {
    japanese: "東方天空璋",
    english: "HSiFS",
    supported: false,
    icon: 'th16.png',
  },
  {
    japanese: "秘封ナイトメア\nダイアリー",
    english: "Violet Detector",
    supported: false,
    icon: 'th165.png',
  },
  {
    japanese: "東方鬼形獣",
    english: "WBaWC",
    supported: false,
    icon: 'th17.png',
  },
  {
    japanese: "東方虹龍洞",
    english: "UM",
    supported: false,
    icon: 'th18.png',
  },
  {
    japanese: "東方錦上京",
    english: "Fossilized Wonders",
    supported: false,
    icon: 'th20.png',
  },
];

function formatFileSize(bytes: number): string {
  return `${(bytes / 1024).toFixed(2)}KB`;
}

export function UploadForm({ onMagicLinkSent }: Props) {
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
      setErrorMessage("リプレイファイル（.rpy）を選択してください");
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
        err instanceof SattoriApiError ? err.message : "予期しないエラーが発生しました";
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
      await requestMagicLink(
        replayKey,
        { watermark },
        email,
        preview?.game,
        preview?.estimatedDurationSeconds,
      );
      onMagicLinkSent(email);
    } catch (err) {
      const message =
        err instanceof SattoriApiError ? err.message : "予期しないエラーが発生しました";
      setErrorMessage(message);
      setPhase("ready");
    }
  }

  function renderPreview() {
    if (phase === "uploading") {
      return <ReplayPreview status="loading" label="アップロード中…" />;
    }
    if (phase === "parsing") {
      return <ReplayPreview status="loading" label="リプレイを解析しています…" />;
    }
    if (preview) {
      return <ReplayPreview status="ready" info={preview} />;
    }
    return <ReplayPreview status="empty" />;
  }

  return (
    <section className={styles.card}>
      <p className={styles.supportedTitlesLabel}>
        現在録画対応中のタイトル ({gameTitles.filter((t) => t.supported).length}作品)
      </p>
      <ul className={styles.supportedTitles}>
        {gameTitles.map((t) => (
          <li key={t.english} className={clsx(styles.supportedTitle, t.supported && styles.supported)}>
            <img src={`/icons/${t.icon}`} alt={t.japanese} className={styles.supportedTitleIcon} />
            <span className={styles.supportedTitleName}>{t.japanese}</span>
          </li>
        ))}
      </ul>
      <p className={styles.stepLabel}>
        <span className={styles.stepNumber}>STEP 1</span>
        リプレイファイルを選択
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
            <span className={styles.emphasisDropzone}>ここをクリック</span>
            してリプレイファイル (.rpy) をアップロード
            <br/>
            もしくはドラッグ&ドロップ
          </>}
        </span>
      </label>

      {errorMessage && <p className={styles.error}>{errorMessage}</p>}

      <p className={clsx(styles.stepLabel, styles.stepLabelSecondary)}>
        <span className={styles.stepNumber}>STEP 2</span>
        内容を確認
      </p>
      {renderPreview()}

      <p className={clsx(styles.stepLabel, styles.stepLabelSecondary)}>
        <span className={styles.stepNumber}>STEP 3</span>
        メールアドレスを入力
      </p>
      <input
        type="email"
        className={styles.emailInput}
        placeholder="komeiji@example.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        disabled={busy}
      />
      <small className={styles.optionHint}>
        録画した動画をダウンロードするためのリンクがメールで送信されます。
      </small>

      <details className={styles.details}>
        <summary className={styles.summary}>詳細設定</summary>
        <label className={styles.option}>
          <input
            type="checkbox"
            checked={watermark}
            onChange={(e) => setWatermark(e.target.checked)}
            disabled={busy}
          />
          <span>
            ウォーターマークを合成する
            <small className={styles.optionHint}>
              リプレイ本編が始まるまでの数秒間、動画右下に「TouhouSattori」のロゴが表示されます。<br/>
              リプレイ再生中の画面には表示されません。
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
        {phase === "starting" ? "少女祈祷中⋯" : "次へ"}
      </button>
    </section>
  );
}
