import { createContext, useContext, useState, type Dispatch, type SetStateAction } from "react";
import { DEFAULT_RECORDING_OPTIONS, type ReplayInfo } from "@sattori/shared";

/**
 * idle: 未選択、または直前の選択がエラーで終わった状態。
 * processing: ファイル選択直後に自動で走る、ブラウザ内解析（`@sattori/touhou-replay-parser`
 *   を`@sattori/shared`経由で直接呼ぶ）とS3アップロード（署名URL取得→PUT）を並行実行中。
 *   解析はアップロード完了を待たずに終わるため、`preview`はこのフェーズの途中で
 *   先に埋まりうる（`UploadForm.renderPreview`参照）。
 * ready: 解析・アップロードともに完了。プレビュー表示中で「次のステップ」が押せる。
 * starting: 「次のステップ」押下後、録画ジョブを起動中。
 * sent: マジックリンクの送信要求が成功し、`MagicLinkSent`を表示中。ファイル選択・
 *   解析結果・`replayKey`はすべて保持したままなので、「戻る」で`ready`に戻れば
 *   アップロードのやり直し無しに設定を変えて再送できる。
 */
export type UploadFormPhase = "idle" | "processing" | "ready" | "starting" | "sent";

export interface UploadFormPersistedState {
  file: File | null;
  setFile: Dispatch<SetStateAction<File | null>>;
  replayKey: string | null;
  setReplayKey: Dispatch<SetStateAction<string | null>>;
  preview: ReplayInfo | null;
  setPreview: Dispatch<SetStateAction<ReplayInfo | null>>;
  watermark: boolean;
  setWatermark: Dispatch<SetStateAction<boolean>>;
  email: string;
  setEmail: Dispatch<SetStateAction<string>>;
  phase: UploadFormPhase;
  setPhase: Dispatch<SetStateAction<UploadFormPhase>>;
  slowMotionTouched: boolean;
  setSlowMotionTouched: Dispatch<SetStateAction<boolean>>;
  slowMotion: boolean;
  setSlowMotion: Dispatch<SetStateAction<boolean>>;
  th10BugfixMarisaB: boolean;
  setTh10BugfixMarisaB: Dispatch<SetStateAction<boolean>>;
}

export const UploadFormStateContext = createContext<UploadFormPersistedState | null>(null);

/**
 * `UploadForm`のSTEP1〜3の入力・解析結果を`App.tsx`の`Layout`直下で保持するための
 * state本体。react-router-domのクライアントサイド遷移では`Layout`はアンマウントされない
 * ため（`Outlet`配下だけが差し替わる）、`/replay-help`や`/terms`など他ページへ移動して
 * ブラウザの「戻る」で`HomePage`（`UploadForm`）へ戻ってきても、ここに載せた入力は
 * 保持されたままになる。呼び出しは`Layout`の1箇所のみを想定。
 */
export function useUploadFormPersistedState(): UploadFormPersistedState {
  const [file, setFile] = useState<File | null>(null);
  const [replayKey, setReplayKey] = useState<string | null>(null);
  const [preview, setPreview] = useState<ReplayInfo | null>(null);
  const [watermark, setWatermark] = useState(DEFAULT_RECORDING_OPTIONS.watermark);
  const [email, setEmail] = useState("");
  const [phase, setPhase] = useState<UploadFormPhase>("idle");
  const [slowMotionTouched, setSlowMotionTouched] = useState(false);
  const [slowMotion, setSlowMotion] = useState(false);
  const [th10BugfixMarisaB, setTh10BugfixMarisaB] = useState(
    DEFAULT_RECORDING_OPTIONS.th10BugfixMarisaB,
  );

  return {
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
  };
}

/** `UploadFormStateContext.Provider`配下でのみ呼べる。Provider外で呼ぶのは実装ミスのため例外にする。 */
export function useUploadFormState(): UploadFormPersistedState {
  const value = useContext(UploadFormStateContext);
  if (!value) {
    throw new Error("useUploadFormState は UploadFormStateContext.Provider の配下でのみ使用できます");
  }
  return value;
}
