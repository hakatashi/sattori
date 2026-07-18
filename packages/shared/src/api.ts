import type { GameId } from "./games.js";
import type { JobStatus, RecordingOptions } from "./job.js";
import type { ReplayInfo } from "./replay.js";

/**
 * フロントエンド（apps/web）とバックエンド（apps/api）で共有するAPI契約。
 * フェーズ1の最小フロー: 署名付きURL発行 → S3直PUT → ジョブ起動 → 状態ポーリング。
 */

/** POST /uploads : 署名付きアップロードURLの発行要求。 */
export interface CreateUploadRequest {
  /** 元のファイル名（拡張子 .rpy の確認・表示用）。 */
  filename: string;
  /** バイト数（サイズ上限チェック用）。 */
  size: number;
}

/** POST /uploads のレスポンス。 */
export interface CreateUploadResponse {
  /** アップロード先S3オブジェクトキー（ジョブ起動時にそのまま渡す）。 */
  replayKey: string;
  /** ブラウザからPUTする署名付きURL。 */
  uploadUrl: string;
}

/** POST /replays/parse : アップロード済みリプレイの解析要求（ページAのプレビュー用）。 */
export interface ParseReplayRequest {
  /** CreateUploadResponse.replayKey をそのまま渡す。 */
  replayKey: string;
}

/**
 * POST /replays/parse のレスポンス（解析成功時）。
 * 非対応タイトル・非対応バージョン・破損ファイルは 422 + ApiError で返す
 * （`code` は `ReplayParseErrorCode` のいずれか）。
 */
export type ParseReplayResponse = ReplayInfo;

/** POST /jobs : 録画ジョブの起動要求。 */
export interface CreateJobRequest {
  /** CreateUploadResponse.replayKey をそのまま渡す。 */
  replayKey: string;
  /** フェーズ1では省略可（クライアント判定 or 既定 th07）。フェーズ2でパーサー結果を渡す。 */
  game?: GameId;
  options: RecordingOptions;
}

/** POST /jobs のレスポンス。 */
export interface CreateJobResponse {
  jobId: string;
  status: JobStatus;
}

/** GET /jobs/{jobId} のレスポンス（ページBのポーリング）。 */
export interface GetJobResponse {
  jobId: string;
  game: GameId;
  status: JobStatus;
  /** 完了時のダウンロードURL（CloudFront配信、未完了なら null）。 */
  downloadUrl: string | null;
  error: string | null;
  updatedAt: string;
}

/** APIエラーの統一形。 */
export interface ApiError {
  code: string;
  message: string;
}
