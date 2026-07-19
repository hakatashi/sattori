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

/**
 * POST /magic-links : マジックリンクメールの送信要求（ページAの「次のステップ」）。
 * この時点で `JobRecord` は作成される（status: "pending"）が、Step Functionsは
 * まだ起動しない。払い出された `jobId` はAPIレスポンスには含めず、メール本文の
 * リンクとしてのみ通知する（jobIdはメールを確認しないと分からない、録画起動の
 * 実質的な秘密として機能する。Issue #9）。
 */
export interface RequestMagicLinkRequest {
  /** CreateUploadResponse.replayKey をそのまま渡す。 */
  replayKey: string;
  /** フェーズ1では省略可（クライアント判定 or 既定 th07）。フェーズ2でパーサー結果を渡す。 */
  game?: GameId;
  options: RecordingOptions;
  /**
   * `POST /replays/parse` の `ReplayInfo.estimatedDurationSeconds` をそのまま渡す。
   * ワーカーの録画進捗率表示にのみ使う参考値（省略・null なら進捗率は算出されない）。
   */
  estimatedDurationSeconds?: number | null;
  /** マジックリンクの送信先。同一メール（`+`エイリアス正規化後）は24時間5件までのレート制限対象。 */
  email: string;
}

/** POST /magic-links のレスポンス（送信成功、bodyは空でよい。jobIdは含めない）。 */
export type RequestMagicLinkResponse = Record<string, never>;

/**
 * POST /jobs/{jobId}/start : ジョブページ（メールのリンク先）を開いた際に呼ぶ、
 * 録画起動要求。jobIdのみで認可する（jobId自体がメールを確認しないと分からない
 * 秘密値）。同一jobIdに対して複数回呼ばれても録画が起動するのは最初の1回のみで、
 * 2回目以降は起動済みの現在のステータスをそのまま返す（冪等。Issue #9）。
 */
export interface StartJobResponse {
  jobId: string;
  status: JobStatus;
}

/** GET /jobs/{jobId} のレスポンス（ページBのポーリング）。 */
export interface GetJobResponse {
  jobId: string;
  game: GameId;
  status: JobStatus;
  /** 完了時のダウンロードURL（録画そのままの解像度、CloudFront配信、未完了なら null）。 */
  downloadUrl: string | null;
  /**
   * 完了時の720pアップスケール版ダウンロードURL（CloudFront配信、未完了なら null）。
   * YouTube等での60fps認識のため、ページBの主要ダウンロードボタンはこちらを既定とする。
   */
  downloadUrl720p: string | null;
  error: string | null;
  updatedAt: string;
  /** 現在のフェーズ（recording/converting）内での処理進捗率（0-100）。不明なら null。 */
  progress: number | null;
  /**
   * 録画中の画面プレビュー画像URL（CloudFront配信）。
   * status が recording/converting の間のみ値を持ち、それ以外（完了・失敗後）は null。
   */
  previewImageUrl: string | null;
}

/** APIエラーの統一形。 */
export interface ApiError {
  code: string;
  message: string;
}
