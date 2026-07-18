import { useState } from "react";
import { DEFAULT_RECORDING_OPTIONS } from "@sattori/shared";
import { createJob, createUpload, SattoriApiError, uploadReplay } from "../api/client.ts";
import styles from "./UploadForm.module.css";
import clsx from "clsx";

interface Props {
  onJobStarted: (jobId: string) => void;
}

type Phase = "idle" | "uploading" | "starting";

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
    supported: false,
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
    english: "UFO",
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

export function UploadForm({ onJobStarted }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [watermark, setWatermark] = useState(DEFAULT_RECORDING_OPTIONS.watermark);
  const [phase, setPhase] = useState<Phase>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const busy = phase !== "idle";

  function selectFile(selected: File | null) {
    setErrorMessage(null);
    if (selected && !selected.name.toLowerCase().endsWith(".rpy")) {
      setFile(null);
      setErrorMessage("リプレイファイル（.rpy）を選択してください");
      return;
    }
    setFile(selected);
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

  async function handleSubmit() {
    if (!file) {
      return;
    }
    setErrorMessage(null);
    try {
      setPhase("uploading");
      const upload = await createUpload({ filename: file.name, size: file.size });
      await uploadReplay(upload.uploadUrl, file);

      setPhase("starting");
      const job = await createJob(upload.replayKey, { watermark });
      onJobStarted(job.jobId);
    } catch (err) {
      const message =
        err instanceof SattoriApiError ? err.message : "予期しないエラーが発生しました";
      setErrorMessage(message);
      setPhase("idle");
    }
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
          {file ? file.name : <>
            <span className={styles.emphasisDropzone}>ここをクリック</span>
            してリプレイファイル (.rpy) をアップロード
            <br/>
            もしくはドラッグ&ドロップ
          </>}
        </span>
      </label>

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

      {errorMessage && <p className={styles.error}>{errorMessage}</p>}

      <button
        type="button"
        className={styles.submit}
        onClick={handleSubmit}
        disabled={!file || busy}
      >
        {phase === "uploading"
          ? "アップロード中…"
          : phase === "starting"
            ? "録画を開始しています…"
            : "録画を開始する"}
      </button>
    </section>
  );
}
