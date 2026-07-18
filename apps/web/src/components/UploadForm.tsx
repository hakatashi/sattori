import { useState } from "react";
import { DEFAULT_RECORDING_OPTIONS } from "@sattori/shared";
import { createJob, createUpload, SattoriApiError, uploadReplay } from "../api/client.ts";
import styles from "./UploadForm.module.css";

interface Props {
  onJobStarted: (jobId: string) => void;
}

type Phase = "idle" | "uploading" | "starting";

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
