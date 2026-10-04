import { createContext, useContext, useState, type Dispatch, type SetStateAction } from "react";
import { DEFAULT_RECORDING_OPTIONS, type RecordingSpeed, type ReplayInfo } from "@sattori/shared";

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
  th10BugfixMarisaB: boolean;
  setTh10BugfixMarisaB: Dispatch<SetStateAction<boolean>>;
  th06ncHighResolution: boolean;
  setTh06ncHighResolution: Dispatch<SetStateAction<boolean>>;
  /**
   * ユーザーが明示的に選んだ録画速度（Issue #288）。null なら「おすすめ」
   * （`recommendedRecordingSpeed()`）に従う。おすすめはタイトルとth06ncの解像度で変わるため、
   * 未選択の間は値を保持せず都度導出する（解像度を切り替えたときに追従させるため）。
   * 別のリプレイを選び直したら null に戻す。
   */
  recordingSpeedChoice: RecordingSpeed | null;
  setRecordingSpeedChoice: Dispatch<SetStateAction<RecordingSpeed | null>>;
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
  const [th10BugfixMarisaB, setTh10BugfixMarisaB] = useState(
    DEFAULT_RECORDING_OPTIONS.th10BugfixMarisaB,
  );
  const [th06ncHighResolution, setTh06ncHighResolution] = useState(
    DEFAULT_RECORDING_OPTIONS.th06ncHighResolution,
  );
  const [recordingSpeedChoice, setRecordingSpeedChoice] = useState<RecordingSpeed | null>(null);

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
    th10BugfixMarisaB,
    setTh10BugfixMarisaB,
    th06ncHighResolution,
    setTh06ncHighResolution,
    recordingSpeedChoice,
    setRecordingSpeedChoice,
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
