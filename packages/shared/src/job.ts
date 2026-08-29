import type { GameId } from "./games.js";
import type { SupportedLanguage } from "./language.js";
import type { ReplayInfo } from "./replay.js";
import type { HomeWorkerOfferState, WorkerEnvironment, WorkerKind } from "./worker.js";

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
  /**
   * 低速録画（Issue #68）。ゲームを 1/2 倍速で走らせて録画し、後処理で等倍へ戻す
   * ことで、等倍では処理落ちするタイトル（th20）の録画品質を担保する。
   * 詳細と定数は `slowMotion.ts` 参照。
   *
   * **低速録画に対応したタイトル（`SLOW_MOTION_SUPPORTED_GAME_IDS`）でしか選べない**。
   * 非対応タイトルではページAがグレーアウトし、`POST /magic-links` も true を握り潰す
   * （Issue #101）。
   *
   * さらに**自宅ワーカー（Issue #49）がこの能力を宣言している場合しか選べない**
   * （EC2 Spot では録画に倍の実時間＝倍のコストがかかるため）。ページAは
   * `GET /worker-availability` で可否を確認し、使えない間はチェックボックスを
   * グレーアウトする。ここが true でも、実際に自宅ワーカーがclaimしなければ
   * EC2 での等倍録画へフォールバックする（`apps/api/src/handlers/sfn/launch.ts`）。
   * デフォルト false（既定でオンにするのは th20 のみで、その判断は
   * `defaultSlowMotionFor()` がフロントエンド側で行う）。
   */
  slowMotion: boolean;
  /**
   * th10（東方風神録）の既知バグ「バグマリ」（魔理沙Bのパワーが3.00〜3.95の間に
   * あるときショット火力が異常上昇する）をVsyncPatchで修正した状態で録画するか
   * （Issue #75）。詳細と定数は `th10BugfixMarisaB.ts` 参照。
   *
   * これは録画品質の設定ではなく、**リプレイを記録した際のVsyncPatch設定を録画側へ
   * 伝えるための申告**である。記録時と異なる設定で再生するとリプレイずれが起きるが、
   * リプレイファイル自体にはこの設定情報が含まれないため録画側では自動判別できない
   * （`worker/docs/titles/th10.md`）。
   *
   * **「th10かつ魔理沙B」のリプレイでしか選べない**
   * （`supportsTh10BugfixMarisaB()`）。それ以外の組み合わせではページAがグレーアウト
   * し、`POST /magic-links` も true を握り潰す。デフォルト false（未修正=バグ挙動を
   * 再現する方が大半のリプレイに合致するため）。
   */
  th10BugfixMarisaB: boolean;
}

export const DEFAULT_RECORDING_OPTIONS: RecordingOptions = {
  watermark: true,
  slowMotion: false,
  th10BugfixMarisaB: false,
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
   * 本サービスのコスト構造で最大のレバレッジ（`docs/research/aws-region-cost-analysis.md` §6）
   * なので、平均値で丸めずジョブ単位の実測を残す。旧ジョブでは null。
   */
  outputBytes: number | null;
  /** `outputPath720p`の動画のバイト数（未アップロード・旧ジョブなら null）。 */
  outputBytes720p: number | null;
  /** 失敗時のエラー概要（ユーザー表示用の簡潔な文言、常に日本語固定）。 */
  error: string | null;
  /**
   * `error`に対応する機械可読コード（`ApiError.code`と同じ語彙。例:
   * `"launch_failed"`）。バックエンド・ワーカーが`error`と同時に書き込む
   * （`apps/api/src/jobs.ts`の`updateJobStatus()`・`worker/status.py`の
   * `update_status()`）。フロントエンドはこれを軸に`errors.<code>`へ翻訳する
   * （`apps/web/src/i18n/apiErrors.ts`、Issue #138）ため、`error`だけを書き換えて
   * `errorCode`を付け忘れると、そのメッセージは英語版で翻訳されず日本語のまま
   * 表示される。既存の日本語文言に対応するコードが無い場合は null（`error`の
   * 生文言をそのまま表示する）。
   */
  errorCode: string | null;
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
   * このジョブを実行している（実行した）ワーカーの種別（Issue #49）。ジョブ作成時は
   * null で、`Launch` の割り当てが確定した時点で `ec2`（EC2 Fleetを起動した）か
   * `home`（自宅ワーカーがclaimした）が入る。**コスト推定はこの値で分岐する**
   * （自宅ワーカーのジョブにはEC2/EBS/IPv4の課金が一切発生しない。`cost.ts`）。
   * Step Functionsのリトライで割り当てが変われば上書きされるため、最後の試行の
   * 種別を表す。
   */
  workerKind: WorkerKind | null;
  /**
   * 自宅ワーカーへオファー中であることを示すマーカー（Issue #49）。
   * `HomeWorkerOfferIndex`（sparse GSI）のパーティションキーで、**オファー中の
   * ジョブだけがこの属性を持つ**（撤回・claim時は属性ごと削除する）ため、
   * インデックスがそのまま「いまオファー中のジョブ一覧」になる。
   *
   * 以下のオファー関連フィールドと `stopRequestedAt` だけ `| null` ではなく optional
   * なのは、DynamoDBのNULL型を書くとGSIのキー属性として不適合になるうえ「属性が無い」
   * ことをそのまま条件式（`attribute_not_exists`）で表現したいため。
   */
  homeWorkerOfferState?: HomeWorkerOfferState;
  /** オファーの期限（ISO 8601）。GSIのソートキーも兼ねる。 */
  homeWorkerOfferExpiresAt?: string;
  /**
   * オファーに添えるワーカーコンテナの環境変数一式（`taskToken`を含む）。
   * 自宅デーモンはこれをそのまま `docker run -e` へ渡すだけでよく、
   * ワーカー起動パラメータの組み立てロジックをAWS側（`apps/api/src/workerEnv.ts`）
   * に一本化できる。ジョブ完了時にデーモンが削除する（使用済みtaskTokenを
   * 残さないため）。
   */
  homeWorkerEnv?: WorkerEnvironment;
  /**
   * ジョブをclaimした自宅ワーカーのID（`WorkerHeartbeat.workerId`）。
   * claim済みかどうかの唯一の真実で、デーモンは自分のIDである限りにおいてのみ
   * 実行を続ける（`HandleFailure`がこの属性を消すと、デーモンは次のハートビート
   * 更新で気づいてコンテナを停止する＝claimの取り消し手段を兼ねる）。
   */
  assignedWorkerId?: string;
  /** 自宅ワーカーが最後にジョブの生存を報告した時刻（ISO 8601、運用調査用）。 */
  homeWorkerHeartbeatAt?: string;
  /**
   * 管理画面から緊急停止（`POST /admin/jobs/{jobId}/stop`、Issue #59）が要求された
   * 時刻（ISO 8601）。**この属性があるジョブに対するワーカーからのstatus更新は
   * すべて拒否される**（`worker/status.py` の `update_status` が
   * `attribute_not_exists(stopRequestedAt)` を条件に書くため）。
   *
   * 停止処理は「Step Functions実行の停止 → ワーカーの後始末 → `failed` の確定」の
   * 順に進むが、EC2の`TerminateInstances`と違って自宅ワーカー（Issue #49）の停止は
   * 同期的ではない（デーモンが`CLAIM_CHECK_INTERVAL_SEC`ごとのポーリングで
   * claimの取り消しに気づくまで、コンテナは走り続ける）。その間にコンテナが
   * 完走すると`done`とdoneAtが書かれ、DynamoDB Streams経由で
   * **停止したはずのジョブの完了メールがユーザーへ飛ぶ**。この拒否票は、
   * 停止要求がワーカーの生存期間より確実に長生きするようにするためのもの。
   */
  stopRequestedAt?: string;
  /**
   * `POST /magic-links` 押下時点でユーザーが選択していた表示言語
   * （`RequestMagicLinkRequest.language` をそのまま転記）。マジックリンク
   * メール・完了メールの文面出し分けと、メール本文に載せるジョブページリンクの
   * 言語（`/` = ja, `/en` = en）に使う。
   */
  language: SupportedLanguage;
  /**
   * 録画終了時のゲーム内スコアが `replayInfo.score`（リプレイファイルの記録スコア）と
   * 一致しなかった疑い（リプレイずれ／デシンク、Issue #103）。ワーカーが録画成功を
   * 確定させた直後に一度だけ判定し、`status` が converting 以降になった時点で値を持つ
   * （`worker/recording_common.py` の `check_replay_desync()`）。
   *
   * MOD が RVA 直指定で読んでいるゲーム内部の生値に基づく判定であり、信頼性は高くない
   * （ゲームデータのバージョン差で無意味な値になりうる、touhou-recorder
   * reports/53_phase53_score_monitor_all_titles.md）。そのため不一致を検知しても
   * 自動リトライ・失敗扱いはしない——ユーザーへの注意書き表示にのみ使う。
   *
   * `true`=不一致（リプレイずれの疑い）、`false`=一致、`null`=未検証（このフィールド
   * 追加より前のジョブ・MODのスコアログが取得できなかった等）。
   */
  desyncDetected: boolean | null;
  /**
   * リプレイ終了を検知できないままタイムアウトで打ち切られた録画か（Issue #161）。
   * ワーカーが録画成功を確定させた直後に一度だけ判定し、`status` が converting
   * 以降になった時点で値を持つ（`worker/recording_common.py` の
   * `attempt_recording()` が返す `classification` が `"timeout"` かどうかで決まる）。
   *
   * テンプレート照合・画面静止でリプレイ終了を検知できず録画時間の上限に達した
   * ことを意味し、リプレイ終盤が録画されていない可能性が高い（fps低下でゲーム内
   * 進行が想定より遅れるケースが実機で確認された、Issue #161）。2026-08-24に確認
   * された実例のfps低下自体はサーマルスロットリング（Issue #162）が原因と判明し
   * クーラー換装で解消済み（PR #180）だが、冷却以外の要因での再発は排除できない
   * ため自動リトライ・失敗扱いはせず、`desyncDetected` と同様にユーザーへの
   * 注意書き表示にのみ使う。
   *
   * `true`=タイムアウト打ち切り、`false`=リプレイ終了を検知して正常終了、
   * `null`=このフィールド追加より前のジョブ、または録画が全試行失敗した場合。
   */
  timedOut: boolean | null;
}
