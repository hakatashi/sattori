import type { GameId } from "./games.js";
import type { JobStatus, RecordingOptions } from "./job.js";
import type { SupportedLanguage } from "./language.js";
import type { ReplayInfo } from "./replay.js";
import type { WorkerCapability } from "./worker.js";

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

/**
 * メールアドレスの簡易形式チェック用パターン。フロントエンド（入力時の活性化制御）と
 * バックエンド（`POST /magic-links`）の両方で使う。片方だけ変更されて判定基準が
 * ズレることを防ぐため、ここに一本化する。
 */
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
  options: RecordingOptions;
  /** マジックリンクの送信先。同一メール（`+`エイリアス正規化後）は24時間5件までのレート制限対象。 */
  email: string;
  /**
   * 「次のステップ」押下時点でユーザーが選択していた表示言語。マジックリンク
   * メール・完了メールの文面、およびメール本文に載せるジョブページリンクの
   * 言語（`/` = ja, `/en` = en）を出し分けるために `JobRecord` へ転記して保持する。
   * 省略・不正値なら `DEFAULT_LANGUAGE`（ja）として扱う。
   */
  language?: SupportedLanguage;
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
  /**
   * ダウンロード可能な期限（ISO 8601、CloudFront/S3のキャッシュではなく出力バケットの
   * ライフサイクルルールによる自動削除時刻）。完了（`doneAt`が確定している）ジョブの
   * みで値を持ち、未完了・`doneAt`未設定の旧ジョブでは null。
   */
  downloadExpiresAt: string | null;
  error: string | null;
  /** `JobRecord.errorCode`をそのまま転記する。`errors.<code>`翻訳の軸（Issue #138）。 */
  errorCode: string | null;
  updatedAt: string;
  /**
   * 現在のフェーズ（recording/converting）内で実際に処理が完了した時間（秒）。
   * 全体の長さに対する割合ではなく経過秒数そのもの（不明なら null）。割合として
   * 表示する場合は `replayInfo.estimatedDurationSeconds` を分母として算出する。
   */
  progress: number | null;
  /**
   * 完了時のプレビュー再生用URL（`<video>`の`src`、720p版。無ければ元解像度版）。
   * `downloadUrl720p`と実体は同じオブジェクトだが、こちらは
   * `response-content-disposition`クエリを**付けない**（付けるとCloudFrontの
   * キャッシュキーが変わるうえ、ダウンロード用URLと役割が混ざるため）。
   * 完了していない・出力が無いジョブでは null。
   */
  previewVideoUrl: string | null;
  /**
   * 録画中の画面プレビュー画像URL（CloudFront配信）。
   * status が recording/converting/done の間のみ値を持ち、失敗後は null。
   * done での用途はプレビュープレイヤーの`poster`（`previewVideoUrl`参照）で、
   * 進捗表示のサムネイルとしては使わない。
   */
  previewImageUrl: string | null;
  /**
   * ページAで解析済みのリプレイ内容（STEP2と同じ表示に使う）。
   * `POST /magic-links` 時点で `replayInfo` が渡されていなかった旧ジョブでは null。
   */
  replayInfo: ReplayInfo | null;
  /**
   * このジョブが低速録画（Issue #68）で走る（走った）か。`isSlowMotionRecording()`
   * の結果そのもの——ユーザーの希望（`RecordingOptions.slowMotion`）ではなく、
   * EC2 へフォールバックしたかどうかまで織り込んだ値である。
   * ジョブページの進捗バー・残り時間推定が、録画フェーズに実時間で倍かかることを
   * 織り込むために使う（`apps/web/src/hooks/jobProgressBudget.ts`）。
   */
  slowMotion: boolean;
}

/**
 * GET /worker-availability : 常駐ワーカー（自宅ワーカー、Issue #49）が今この瞬間に
 * ジョブを引き受けられるかの公開スナップショット。ページAの詳細設定で
 * 「低速録画」（Issue #68）を選べるかどうかの判定にだけ使う。
 *
 * **これはあくまで「今の」状態**で、実際に録画が始まるのはユーザーがメールの
 * マジックリンクを開いた後（最大24時間後）なので、ここで true でも録画時には
 * 自宅ワーカーが埋まっている・落ちていることがある。その場合はEC2での等倍録画へ
 * 静かにフォールバックする（`isSlowMotionRecording()` 参照）。
 *
 * ワーカーの `workerId`・台数・負荷といった運用情報は**返さない**。この
 * エンドポイントは認証なしで公開されるため、開発者の自宅環境の稼働状況が
 * 必要以上に外から見えないようにする。
 */
export interface GetWorkerAvailabilityResponse {
  /** 今オファーを受けられる常駐ワーカーが1台以上いるか。 */
  available: boolean;
  /**
   * 上記のワーカー群が申告している追加能力の和集合（`WorkerCapability`）。
   * 低速録画が選べるかは `capabilities.includes(SLOW_MOTION_CAPABILITY)` で判定する。
   */
  capabilities: WorkerCapability[];
}

/** APIエラーの統一形。 */
export interface ApiError {
  code: string;
  message: string;
}
