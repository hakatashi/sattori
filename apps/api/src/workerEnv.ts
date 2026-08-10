import type {
  AdminJobRecord,
  JobRecord,
  RedactedWorkerEnvironment,
  WorkerEnvironment,
} from "@sattori/shared";
import type { ApiConfig } from "./config.js";

/**
 * 録画ワーカーコンテナ（`worker/entrypoint.py`）へ渡す環境変数一式を組み立てる。
 *
 * **EC2 Fleet で起動する場合と自宅ワーカー（Issue #49）がclaimする場合で、ここを
 * 共有する**のが要点。EC2では `buildUserData()` が `docker run -e` へ展開し、
 * 自宅ワーカーではオファーに添えて `JobRecord.homeWorkerEnv` へ書き、デーモンが
 * そのまま `docker run` へ渡す。ワーカー側は「自分がどこで動いているか」を一切
 * 知らずに済み、環境差分はすべてこの関数の出力の違いとして表現される。
 *
 * この構造は Issue #68（1/2倍速録画。自宅ワーカーでのみ行う予定）の受け皿でもある。
 * 低速録画は「自宅ワーカーなら分岐する」ではなく「起動側が録画速度を指定する
 * 環境変数を足すかどうか」で表現すること。
 */
export function buildWorkerEnv(
  config: ApiConfig,
  job: JobRecord,
  taskToken: string,
): WorkerEnvironment {
  const env: WorkerEnvironment = {
    AWS_DEFAULT_REGION: config.ec2.region,
    AWS_REGION: config.ec2.region,
    JOB_ID: job.jobId,
    GAME: job.game,
    REPLAY_BUCKET: config.uploadBucket,
    REPLAY_KEY: job.replayKey,
    OUTPUT_BUCKET: config.outputBucket,
    TITLE_ASSETS_BUCKET: config.titleAssetsBucket,
    JOBS_TABLE: config.jobsTable,
    WATERMARK: job.options.watermark ? "1" : "0",
    TASK_TOKEN: taskToken,
  };
  if (job.estimatedDurationSeconds !== null) {
    // ワーカーの録画進捗率算出用の参考値（取得できていなければ付与しない）。
    env.EXPECTED_DURATION_SECONDS = String(job.estimatedDurationSeconds);
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
