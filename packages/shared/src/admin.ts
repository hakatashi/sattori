import type { JobRecord, JobStatus } from "./job.js";

/**
 * 管理画面（`/admin`、Issue #51）向けのAPI契約。`api.ts` の契約は「ユーザー向け」で
 * `GetJobResponse` が email/instanceId 等の内部データを意図的に除外しているのに対し、
 * こちらは正反対の方針（`JobRecord` をほぼそのまま返す）を取るため、あえて別ファイルに
 * 分離している。管理APIは Lambda Authorizer（共有トークン）の配下にしか存在しないため、
 * 内部データを含めても問題ない前提。
 */

/** GET /admin/jobs の既定・上限件数。 */
export const ADMIN_JOB_LIST_DEFAULT_LIMIT = 20;
export const ADMIN_JOB_LIST_MAX_LIMIT = 100;

/**
 * GET /admin/jobs の1行分。`JobRecord` から `Pick` することで、`JobRecord` に
 * フィールドが増えた際の更新漏れ（型エラーとして検知されない古いサマリ）を防ぐ。
 * 一覧表示に不要な `replayKey`・`pendingExpiresAt`・`language` 等は含めない。
 */
export type AdminJobSummary = Pick<
  JobRecord,
  | "jobId"
  | "game"
  | "status"
  | "createdAt"
  | "updatedAt"
  | "email"
  | "error"
  | "instanceType"
  | "availabilityZone"
  | "progress"
  | "replayInfo"
>;

/** GET /admin/jobs のレスポンス。 */
export interface AdminJobListResponse {
  items: AdminJobSummary[];
  /**
   * 次ページ取得用の不透明カーソル（`GET /admin/jobs?cursor=...`にそのまま渡す）。
   * これ以上ページが無ければ null。中身の形式はクライアントが解釈すべきではない。
   */
  nextCursor: string | null;
}

/**
 * 管理画面のダウンロード導線。ユーザー向け`GetJobResponse`と異なり、
 * `status`が`done`でなくても実体（S3オブジェクト）があればURLを返す
 * （運用調査で`converting`中の生動画チェックポイントを取得したい場合があるため）。
 */
export interface AdminJobDownloads {
  /** アップロード済み.rpyへのS3署名付きGET URL（未アップロード/削除済みなら null）。 */
  replayUrl: string | null;
  /** 録画そのままの解像度の動画（CloudFront配信、未生成なら null）。 */
  videoUrl: string | null;
  /** 720pアップスケール版動画（CloudFront配信、未生成なら null）。 */
  video720pUrl: string | null;
  /** 録画中の進捗プレビュー画像（CloudFront配信、未取得なら null）。 */
  previewImageUrl: string | null;
  /**
   * 720p変換中のffmpeg生ログ（S3署名付きGET URL、Issue #58フォローアップ）。
   * CloudWatch Logsへ全行流すとノイズになるため退避したテキストファイルで、
   * ライフサイクルルールにより3日で自動削除される（未取得/削除済みなら null）。
   */
  ffmpegLogUrl: string | null;
}

/** GET /admin/jobs/{jobId} のレスポンス。 */
export interface AdminJobDetailResponse {
  /**
   * `JobRecord`をそのまま返す（email・instanceId等の内部データを含む）。
   * 要件が「ジョブの詳細を全て確認できること」であり、ホワイトリスト方式だと
   * `JobRecord`拡張のたびに更新漏れが生じるため、あえて絞り込まない。
   */
  job: JobRecord;
  downloads: AdminJobDownloads;
}

/**
 * Step Functions の実行履歴イベント1件。生の `HistoryEvent` は `*EventDetails` が
 * 40種類以上あり型も巨大なため、非nullだった詳細1つを抜き出して詰め替える。
 */
export interface AdminExecutionEvent {
  id: number;
  previousEventId: number | null;
  /** 例 "TaskStateEntered"、"ExecutionFailed" 等（`HistoryEventType`）。 */
  type: string;
  /** ISO 8601。取得できなければ null。 */
  timestamp: string | null;
  /** 非nullだった `*EventDetails` の中身をそのまま。無ければ null。 */
  details: Record<string, unknown> | null;
}

/** GET /admin/jobs/{jobId}/execution のレスポンス。 */
export interface AdminExecutionResponse {
  /**
   * ジョブに対応するStep Functions実行の概要。実行がまだ存在しない
   * （statusがpendingのまま起動していない）、または実行履歴の保持期間
   * （Standardは90日）を過ぎている場合は null（404にはしない。ジョブ自体は存在する）。
   */
  execution: {
    executionArn: string;
    /** RUNNING | SUCCEEDED | FAILED | TIMED_OUT | ABORTED など。 */
    status: string;
    startDate: string | null;
    stopDate: string | null;
    input: string | null;
    output: string | null;
    error: string | null;
    cause: string | null;
  } | null;
  /** 新しい順、最大100件。 */
  events: AdminExecutionEvent[];
  /** 履歴の続きを取得するためのトークン（将来のページング拡張用、現状フロントは未使用）。 */
  eventsNextToken: string | null;
}

/** CloudWatch Logsのログイベント1件（`GET /admin/jobs/{jobId}/logs`）。 */
export interface AdminLogEvent {
  /** epoch ミリ秒。取得できなければ null。 */
  timestamp: number | null;
  message: string;
}

/** GET /admin/jobs/{jobId}/logs のレスポンス（Issue #58）。 */
export interface AdminLogsResponse {
  /**
   * falseの場合、ロググループ`/sattori/worker`に`jobId`名のログストリームが
   * 存在しない（コンテナが一度も起動できずUserData段階で失敗した可能性が高い。
   * AGENTS.md参照）。この場合`events`は常に空。
   */
  logStreamFound: boolean;
  /** 古い順。Step Functionsのリトライを跨いで同一ストリームに追記されるため、複数回の試行ログが混在しうる。 */
  events: AdminLogEvent[];
  /**
   * これより古いイベントを取得するためのトークン（`?cursor=`にそのまま渡す）。
   * これ以上古いイベントが無ければ null。
   */
  nextBackwardToken: string | null;
  /**
   * `logStreamFound`がfalseの場合のフォールバック。UserData(bootstrap)段階の失敗は
   * awslogsドライバに乗らないため、EC2のコンソール出力を代替表示する
   * （リクエストで`instanceId`が渡され、かつインスタンスの終了から時間が経っておらず
   * 取得できた場合のみ非null）。
   */
  consoleOutput: string | null;
}

/**
 * 管理画面から緊急停止したジョブに記録するエラー文言（`JobRecord.error`）。
 * ワーカー自身やStep Functionsの失敗と区別できるよう、専用の文言を定数化する。
 */
export const ADMIN_STOPPED_JOB_ERROR = "管理者により停止されました";

/** POST /admin/jobs/{jobId}/stop のレスポンス（Issue #59）。 */
export interface AdminStopJobResponse {
  jobId: string;
  /**
   * 停止後のジョブ状態。通常は `failed` だが、停止処理中にワーカーが完走していた
   * 場合のみ `done`（確定した完了を後から `failed` で潰さないため、API側は
   * `done` のジョブ状態を上書きしない。Step Functions実行の停止とインスタンスの
   * 終了自体は実施済み）。
   */
  status: JobStatus;
  /**
   * Step Functions実行に`StopExecution`を発行したか。実行がまだ存在しない
   * （`pending`のまま起動していない・履歴保持期間切れ）場合は false。
   */
  executionStopped: boolean;
  /**
   * EC2インスタンスに`TerminateInstances`を発行したか。`instanceId`が未記録
   * （まだ起動していない）の場合は false。
   */
  instanceTerminated: boolean;
}

/** POST /admin/jobs/{jobId}/retry のレスポンス（Issue #59）。 */
export interface AdminRetryJobResponse {
  /** 複製元（＝リクエストしたパスの）ジョブID。 */
  sourceJobId: string;
  /** 新しく作成して起動したジョブID。管理画面はこのIDの詳細画面へ誘導する。 */
  jobId: string;
  /** 新しいジョブの状態（常に `queued`）。 */
  status: JobStatus;
}
