import {
  NATIVE_RECORDING_SPEED,
  recordingSpeedOf,
  recordingTargetHz,
  requiresGpuRecording,
} from "@sattori/shared";
import type {
  AdminJobRecord,
  JobRecord,
  RedactedWorkerEnvironment,
  WorkerEnvironment,
} from "@sattori/shared";
import { dataBucketsFor } from "./config.js";
import type { ApiConfig } from "./config.js";

/** `buildWorkerEnv()` の、ジョブレコードからは決まらない起動側の都合。 */
export interface WorkerEnvOptions {
  /**
   * EC2 Spot中断監視(`worker/interruption_watcher.py`)を起動するか（Issue #96）。
   * IMDS（`http://169.254.169.254`）はEC2にしか存在しないため、自宅ワーカーで
   * trueを渡すと7秒周期でタイムアウトし続けるログノイズになる。**EC2起動側だけが
   * trueを渡す** —— 呼び出し側（`ec2.buildUserData`/`handlers/sfn/launch.ts`）が
   * 割り当て先に応じて決める。
   */
  spotInterruptionWatch: boolean;
  /**
   * ワーカーを動かすリージョン（Issue #313、`docs/decisions/0062`）。出力バケット・
   * タイトル資産バケットをこのリージョンのものにする（`dataBucketsFor()`）。EC2なら
   * `CreateFleet`の起動先、自宅ワーカーなら一次リージョンを渡す。
   */
  dataRegion: string;
}

/**
 * 録画ワーカーコンテナ（`worker/entrypoint.py`）へ渡す環境変数一式を組み立てる。
 *
 * **EC2 Fleet で起動する場合と自宅ワーカー（Issue #49）がclaimする場合で、ここを
 * 共有する**のが要点。EC2では `buildUserData()` が `docker run -e` へ展開し、
 * 自宅ワーカーではオファーに添えて `JobRecord.homeWorkerEnv` へ書き、デーモンが
 * そのまま `docker run` へ渡す。ワーカー側は「自分がどこで動いているか」を一切
 * 知らずに済み、環境差分はすべてこの関数の出力の違いとして表現される。
 *
 * 録画速度（Issue #288・#316）も「自宅ワーカーなら分岐する」ではなく「起動側が録画速度を
 * 指定する環境変数（`FPS_LIMIT_TARGET_HZ`）を足すかどうか」で表現する。ワーカーは
 * 自分がEC2にいるのか自宅にいるのかを知らないまま、渡された値に従うだけでよい。
 */
export function buildWorkerEnv(
  config: ApiConfig,
  job: JobRecord,
  taskToken: string,
  options: WorkerEnvOptions,
): WorkerEnvironment {
  // 出力・タイトル資産はワーカーと同じリージョンのバケットを使う（Issue #313）。
  // GPUの容量不足フォールバック先（eu-north-1）で動くワーカーがeu-south-2のバケットを
  // 読み書きすると、リージョン間転送料がSpot代の数倍になるため。それ以外（リプレイ・
  // DynamoDB・Step Functions・ログ）は一次リージョンのまま（`AWS_REGION`）。
  //
  // チェックポイント（変換からの再開用の生動画）は**前回の試行が書いた場所**から読む。
  // リトライではリージョンを固定しない（`docs/decisions/0061`）ため、前回と今回で
  // リージョンが違いうる。前回の出力先は`job.outputRegion`（パスと同じ更新で
  // ワーカーが書く）。ワーカーは読み戻したあと、最終出力を自分のリージョンへ書き、
  // チェックポイントは元のバケットから消す（`worker/entrypoint.py`）。
  const data = dataBucketsFor(config, options.dataRegion);
  const checkpoint = dataBucketsFor(config, job.outputRegion);
  const env: WorkerEnvironment = {
    AWS_DEFAULT_REGION: config.ec2.region,
    AWS_REGION: config.ec2.region,
    JOB_ID: job.jobId,
    GAME: job.game,
    REPLAY_BUCKET: config.uploadBucket,
    REPLAY_KEY: job.replayKey,
    OUTPUT_BUCKET: data.outputBucket,
    OUTPUT_BUCKET_REGION: data.region,
    CHECKPOINT_BUCKET: checkpoint.outputBucket,
    CHECKPOINT_BUCKET_REGION: checkpoint.region,
    TITLE_ASSETS_BUCKET: data.titleAssetsBucket,
    TITLE_ASSETS_BUCKET_REGION: data.region,
    JOBS_TABLE: config.jobsTable,
    WATERMARK: job.options.watermark ? "1" : "0",
    TASK_TOKEN: taskToken,
  };
  if (job.estimatedDurationSeconds !== null) {
    // ワーカーの録画進捗率算出用の参考値（取得できていなければ付与しない）。
    env.EXPECTED_DURATION_SECONDS = String(job.estimatedDurationSeconds);
  }
  if (job.replayInfo?.score !== undefined && job.replayInfo?.score !== null) {
    // リプレイずれの事後検証（Issue #103）用の期待スコア（画面表示値）。
    // ワーカーはMODが読んだゲーム内スコアをこれと突き合わせ、一致しなければ
    // `JobRecord.desyncDetected` を true にする
    // （`worker/recording/modlog.py` の `check_replay_desync()`）。
    env.EXPECTED_SCORE = String(job.replayInfo.score);
  }
  const recordingSpeed = recordingSpeedOf(job.options);
  if (recordingSpeed !== NATIVE_RECORDING_SPEED) {
    // 倍速録画（Issue #288）・低速録画（Issue #316）。MOD（QPC偽装・Present上限・音声周波数）と
    // 録画スクリプトの実時間依存パラメータが、この1つの値（60×倍率）から同じ比率でスケールする。
    // QPC偽装の倍率（`SPEED_HACK_MULTIPLIER`）はワーカーがここから導出するので渡さない
    // （2つの値が食い違う余地を作らないため、`worker/recording/config.py`）。
    // 倍速はGPU、低速はEC2のCPU系でしか走らないため、割り当て先で無効化されることは無い。
    env.FPS_LIMIT_TARGET_HZ = String(recordingTargetHz(recordingSpeed));
  }
  if (requiresGpuRecording(job)) {
    // GPU系インスタンス（g6f.2xlarge・g6.2xlarge）で起動するジョブ。ワーカーはGPU描画必須でない
    // タイトルもGPU描画（Xorg+nvidia）で録り、録画・変換ともNVENCでエンコードする
    // （`worker/recording/timing.py`の`gpu_worker()`）。「どこで動くか」ではなく
    // 「何が使えるか」を表す値で、GPUジョブは自宅ワーカーへは決してオファーされない
    // （`workerRouting.ts`）ため、これが立っていればGPUは必ずある。
    env.GPU_WORKER = "1";
  }
  if (options.spotInterruptionWatch) {
    env.SPOT_INTERRUPTION_WATCH = "1";
  }
  if (job.options.th10BugfixMarisaB) {
    // th10「バグマリ」修正オプション（Issue #75）。低速録画と異なりEC2/自宅どちらでも
    // 実時間コストは変わらない（VsyncPatchの`vpatch.ini`を録画直前に書き換えるだけ）ため、
    // `WorkerEnvOptions`を経由せず`job.options`から直接読む——割り当て先に応じて
    // 呼び出し側が値を変える必要が無い。
    env.TH10_BUGFIX_MARISA_B = "1";
  }
  if (job.game === "th06nc" && job.options.th06ncHighResolution) {
    // 1080p録画オプション（Issue #241）。th06ncは自宅ワーカーへは絶対にオファーされない
    // （`workerRouting.ts`の`offerToHomeWorker: false`）ため常にEC2（GPU系）で録画され、
    // th10BugfixMarisaBと同様「割り当て先次第で無効化される」性質のオプションではない。
    // 未指定＝720p（既定値を環境変数で表現しない）。
    env.TH06NC_RESOLUTION = "1080p";
  }
  return env;
}

/**
 * `buildWorkerEnv()` の結果のうち `TASK_TOKEN` を伏せたコピー。ログや
 * 管理画面の表示にそのまま出すと、Step Functions の実行を任意に成功/失敗させられる
 * トークンが漏れるため、外へ出す経路では必ずこれを通す。
 *
 * 「必ず通す」を散文の約束で済ませていた結果 `GET /admin/jobs/{id}` が生きた
 * トークンをそのまま返していたため、**戻り値の型で表明する**方式に変えてある
 * （`RedactedWorkerEnvironment`。外へ出す型はそちらしか受け付けない）。
 */
export function redactWorkerEnv(env: WorkerEnvironment): RedactedWorkerEnvironment {
  const { TASK_TOKEN: _taskToken, ...rest } = env;
  // `WorkerEnvironment` は `Record<string, string>` なので、分割代入の残りにも
  // インデックスシグネチャが残り「TASK_TOKENを含みうる型」のままになる。実体からは
  // 確実に落ちているため、型を絞るのはこの1箇所だけに許す。
  return rest as RedactedWorkerEnvironment;
}

/**
 * ジョブレコードを管理APIのレスポンス用に整える（`homeWorkerEnv` の
 * `TASK_TOKEN` を伏せるだけ）。管理APIは `JobRecord` をあえて絞り込まない方針
 * （`AdminJobRecord` のコメント参照）なので、ここでフィールドを間引かないこと。
 */
export function toAdminJobRecord(job: JobRecord): AdminJobRecord {
  const { homeWorkerEnv, ...rest } = job;
  return homeWorkerEnv === undefined
    ? rest
    : { ...rest, homeWorkerEnv: redactWorkerEnv(homeWorkerEnv) };
}
