import type { GameId } from "./games.js";
import type { ReplayInfo } from "./replay.js";

/**
 * 録画ジョブのライフサイクル。ワーカー（worker/）が進行に応じて DynamoDB を更新し、
 * ページBがポーリングで表示する。
 */
export const JOB_STATUSES = [
  "pending", // マジックリンク送信済み・ジョブページへのアクセス(録画起動)待ち(Issue #9)
  "queued", // ジョブ登録済み・起動待ち
  "launching", // EC2 Spot インスタンス起動中
  "recording", // ゲーム起動〜リプレイ録画中
  "converting", // 録画完了(生動画チェックポイントアップロード済み)〜720pアップスケール変換〜出力アップロード中
  "done", // 完了（動画DL可能）
  "failed", // 失敗（要リトライ or エラー表示）
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

/** 終端状態かどうか（ポーリング停止判定に使う）。 */
export function isTerminalStatus(status: JobStatus): boolean {
  return status === "done" || status === "failed";
}

/** 録画オプション（ページAの詳細設定に対応）。 */
export interface RecordingOptions {
  /** ウォーターマーク合成の有無。デフォルト true（合成する）。 */
  watermark: boolean;
}

export const DEFAULT_RECORDING_OPTIONS: RecordingOptions = {
  watermark: true,
};

/**
 * ジョブレコード（DynamoDBの1アイテムに対応）。
 * `POST /magic-links`の時点で status: "pending" として作成され（Issue #9）、
 * `POST /jobs/{jobId}/start`（ジョブページへのアクセス）で "queued" に遷移して
 * Step Functionsの実行が始まる。
 */
export interface JobRecord {
  jobId: string;
  game: GameId;
  /** アップロードされた .rpy の S3 オブジェクトキー（アップロード用バケット内）。 */
  replayKey: string;
  status: JobStatus;
  options: RecordingOptions;
  /**
   * 出力動画（録画そのままの解像度）の CloudFront 配信パス。
   * 録画完了直後、720p変換の前にチェックポイントとして先行して設定される
   * （変換中にSpot中断が起きても、次のリトライ時にワーカーがこのパスから
   * 生動画をダウンロードして録画をやり直さずに変換から再開できるようにするため）。
   * 未設定（録画未完了）なら null。
   */
  outputPath: string | null;
  /**
   * 完了時の720pアップスケール版動画の CloudFront 配信パス（未完了なら null）。
   * th07(640x480)等の低解像度録画はそのままだと YouTube 側で60fpsとして
   * 認識されないため（touhou-recorder reports/21）、アスペクト比を保ったまま
   * 高さ720pxへ変換した版を別ファイルとして併せて提供する。
   */
  outputPath720p: string | null;
  /** 失敗時のエラー概要（ユーザー表示用の簡潔な文言）。 */
  error: string | null;
  /** ISO 8601。 */
  createdAt: string;
  updatedAt: string;
  /** マジックリンクの送信先メールアドレス。 */
  email: string | null;
  /**
   * status が "pending" の間のみ意味を持つ、録画開始(`POST /jobs/{jobId}/start`)の
   * 受付期限（ISO 8601）。アップロード用S3バケットが1日でオブジェクトを自動削除する
   * ため、それに合わせて作成から24時間としている（それ以降に起動してもリプレイ
   * ファイルが既に削除されており録画が失敗するだけなので、事前に弾く）。
   * pending以外の状態では参照しない。
   */
  pendingExpiresAt: string | null;
  /**
   * ジョブ実行中の EC2 インスタンスID。Step Functions の失敗ハンドラが
   * リトライ/タイムアウト時に孤児インスタンスを terminate するために使う。
   * 未起動または完了後は null。
   */
  instanceId: string | null;
  /**
   * リプレイの推定再生時間（秒）。`ReplayInfo.estimatedDurationSeconds` の値を
   * ジョブ作成時に転記したもの。ワーカーが録画フェーズの進捗率算出に使う
   * （取得できなければ null）。
   */
  estimatedDurationSeconds: number | null;
  /** 現在のフェーズ内での処理進捗率（0-100）。フェーズ開始直後や不明時は null。 */
  progress: number | null;
  /**
   * 録画中の画面プレビュー画像の S3 オブジェクトキー（出力バケット内）。
   * スナップショット毎にユニークなキーを発行する（CloudFrontの長期キャッシュで
   * 古い画像が返り続けるのを避けるため）。未取得なら null。
   */
  previewImagePath: string | null;
  /**
   * ページAで解析済みの `ReplayInfo`（`POST /magic-links` の時点でそのまま転記）。
   * ページBで「今録画しているリプレイの内容」をSTEP2と同じ見た目で表示するために
   * 保持する（表示専用。ワーカーの進捗算出は引き続き `estimatedDurationSeconds`
   * を参照する）。未取得・旧ジョブなら null。
   */
  replayInfo: ReplayInfo | null;
}
