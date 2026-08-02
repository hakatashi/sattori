import type { GameId } from "./games.js";
import type { SupportedLanguage } from "./language.js";
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

/**
 * 出力動画バケット（`infra/lib/sattori-stack.ts` の `OutputBucket`）のS3ライフサイクル
 * ルールによる自動削除までの日数。CDK側もこの値を `Duration.days()` に渡して使うため
 * （インフラの実際の削除日数とAPI/フロントエンドの表示文言が食い違わないようにする）、
 * 変更する場合はここだけを直せばよい。
 */
export const OUTPUT_RETENTION_DAYS = 7;

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
  /**
   * `outputPath`の動画のバイト数（未アップロードなら null）。ワーカーが
   * アップロード時に記録する（`worker/entrypoint.py`）。
   * S3保管料・CloudFront転送量のコスト推定（`cost.ts`）に使う。動画サイズは
   * 本サービスのコスト構造で最大のレバレッジ（`docs/aws-region-cost-analysis.md` §6）
   * なので、平均値で丸めずジョブ単位の実測を残す。旧ジョブでは null。
   */
  outputBytes: number | null;
  /** `outputPath720p`の動画のバイト数（未アップロード・旧ジョブなら null）。 */
  outputBytes720p: number | null;
  /** 失敗時のエラー概要（ユーザー表示用の簡潔な文言）。 */
  error: string | null;
  /** ISO 8601。 */
  createdAt: string;
  updatedAt: string;
  /**
   * **最初に**EC2ワーカーの起動に成功した時刻（ISO 8601、`launching`遷移時刻）。
   * コスト推定（`cost.ts`）における課金対象時間の起点。`createdAt`はマジックリンク
   * 送信要求の時点で、`pending`のまま最大24時間放置されうるため課金の起点には使えない。
   *
   * Step Functionsのリトライで`Launch`が複数回走っても**上書きしない**（起動の度に
   * 上書きすると、それ以前の試行で稼働していたEC2の課金時間が推定から丸ごと
   * 抜け落ちるため）。裏を返すと、`launchedAt`から終了時刻までの実時間には
   * 試行間の待機（インフラ側の`WaitBeforeCheck`、3分）のようなEC2が動いていない
   * 区間も含まれる＝推定は僅かに過大側に倒れる。詳細は`cost.ts`。
   * 未起動、またはこのフィールド追加より前に起動した旧ジョブでは null。
   */
  launchedAt: string | null;
  /**
   * status が "done" に遷移した時刻（ISO 8601）。ワーカーが status を "done" に
   * 更新する際に一度だけ設定する（`worker/status.py`）。出力バケットのライフサイクル
   * ルール（`OUTPUT_RETENTION_DAYS`日で自動削除）の起点はS3オブジェクトの作成日時だが、
   * それとほぼ同時刻に確定するこの値を「ダウンロード期限 = doneAt + retention」の
   * 算出に使う（`apps/api/src/handlers/getJob.ts`）。done未到達、またはこのフィールド
   * 追加より前に完了した旧ジョブでは null。
   */
  doneAt: string | null;
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
   * `CreateFleet` が実際に確保した EC2 インスタンスタイプ（例: `c7i.xlarge`）。
   * 候補インスタンスタイプを複数指定して分散させている（Issue #29、AGENTS.md参照）ため、
   * 実際にどのタイプが割り当てられたかは事後にしか分からない。録画品質（重複フレーム率）
   * の分析・運用調査用に記録する。未起動なら null。
   */
  instanceType: string | null;
  /**
   * `CreateFleet` が実際に確保した EC2 インスタンスのアベイラビリティゾーン
   * （例: `us-east-1a`）。候補サブネット（=AZ）を複数指定して分散させているため、
   * 実際にどのAZが割り当てられたかは事後にしか分からない。運用調査用に記録する。
   * 未起動なら null。
   */
  availabilityZone: string | null;
  /**
   * 起動時点で観測した Spot 単価（USD/時）。`CreateFleet`のレスポンスには単価が
   * 含まれないため、確保できた`instanceType`×`availabilityZone`で
   * `DescribeSpotPriceHistory`を1回引いて記録する（`apps/api/src/ec2.ts`）。
   * 実際の請求額は起動〜終了の間に変動した価格の積分だが、1ジョブは1時間未満で
   * 終わるうえ Spot 価格の変動間隔はそれより長いことがほとんどなので、起動時点の
   * スナップショットで十分という判断。
   *
   * `launchedAt`と同じく最初の起動時のみ記録し、リトライでは上書きしない
   * （試行ごとに違うタイプが確保されうるが、代表値を1つ持てば足りる）。
   * 取得に失敗した場合・旧ジョブでは null で、コスト推定は`instanceType`に応じた
   * フォールバック単価（`cost.ts`）へ縮退する。
   */
  spotPricePerHour: number | null;
  /**
   * リプレイの推定再生時間（秒）。`ReplayInfo.estimatedDurationSeconds` の値を
   * ジョブ作成時に転記したもの。ワーカーが録画フェーズの進捗率算出に使う
   * （取得できなければ null）。
   */
  estimatedDurationSeconds: number | null;
  /**
   * 現在のフェーズ（recording/converting）内で実際に処理が完了した時間（秒）。
   * 全体の長さに対する割合ではなく、経過秒数そのものを持つ（フェーズ開始直後や
   * 不明時は null）。全体の長さに対する割合として表示する場合は
   * `replayInfo.estimatedDurationSeconds` を分母として呼び出し側で算出する。
   */
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
  /**
   * 管理画面から「再実行」（Issue #59）でこのジョブを複製した際に作成された、
   * 新しいジョブのID。再実行していなければ null。同一jobIdでの再起動は
   * `startPendingJob()` の冪等性前提とStep Functionsの実行名(=jobId)の一意性を
   * 壊すため、再実行は必ず新しいjobIdへの複製として行う。この2フィールドで
   * 元ジョブ⇄新ジョブを相互に辿れるようにする（運用調査用）。
   */
  retriedToJobId: string | null;
  /**
   * このジョブが管理画面からの再実行で作られた場合の、複製元ジョブのID
   * （通常のジョブでは null）。
   */
  retriedFromJobId: string | null;
  /**
   * `POST /magic-links` 押下時点でユーザーが選択していた表示言語
   * （`RequestMagicLinkRequest.language` をそのまま転記）。マジックリンク
   * メール・完了メールの文面出し分けと、メール本文に載せるジョブページリンクの
   * 言語（`/` = ja, `/en` = en）に使う。
   */
  language: SupportedLanguage;
}
