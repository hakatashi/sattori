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
 * この時点ではジョブ（DynamoDBレコード）はまだ作らず、Step Functionsも起動しない。
 * メール内のリンクをクリックして `POST /jobs/{jobId}/confirm` を呼ぶまでジョブは実体化しない
 * （Issue #9）。
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

/** POST /magic-links のレスポンス（送信成功、bodyは空でよい）。 */
export type RequestMagicLinkResponse = Record<string, never>;

/**
 * POST /jobs/{jobId}/confirm : マジックリンクの確認・ジョブ起動要求（ページBの初回表示）。
 * トークンが有効（未使用・期限内）であれば、送信要求時の内容からジョブを作成し
 * Step Functions実行を開始する。トークンは単回使用。
 */
export interface ConfirmJobRequest {
  token: string;
}

/** POST /jobs/{jobId}/confirm のレスポンス。 */
export interface ConfirmJobResponse {
  jobId: string;
  status: JobStatus;
}

/**
 * POST /jobs/{jobId}/resend : マジックリンクの再送要求
 * （期限切れ・メール未着時の再送導線）。未使用トークンのみ再送可能、送信は
 * レート制限の対象。
 */
export interface ResendMagicLinkRequest {
  token: string;
}

/** POST /jobs/{jobId}/resend のレスポンス（送信成功、bodyは空でよい）。 */
export type ResendMagicLinkResponse = Record<string, never>;

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
