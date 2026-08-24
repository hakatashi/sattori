/**
 * 自宅ワーカー常駐デーモン（Issue #49）の設定。すべて環境変数で与える。
 *
 * `cdk deploy` の CfnOutput（`JobsTableName`/`WorkersTableName`/`WorkerRepoUri`/
 * `HomeWorkerRoleArn` 等）をそのまま流し込めばよい。値の意味と既定値の根拠は
 * 各フィールドのコメントを参照。
 *
 * **環境変数名は公開仕様**（`home-worker/README.md` §4.1 が文書化している）なので、
 * 変えるならREADMEと運用中のsystemdユニットの `EnvironmentFile` も併せて直すこと。
 */
import { GAME_IDS, SUPPORTED_GAME_IDS, WORKER_CAPABILITIES } from "@sattori/shared";
import type { GameId, WorkerCapability } from "@sattori/shared";

/** 必須の環境変数が欠けている・値が不正である。 */
export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

export interface Config {
  region: string;
  jobsTable: string;
  workersTable: string;
  logGroup: string;
  workerImage: string;
  /**
   * このワーカーの識別子。`WorkersTable` の主キーであり、ジョブの
   * `assignedWorkerId` にも書かれる。複数台にする場合は必ず一意にすること。
   */
  workerId: string;
  /**
   * assume する IAM ロール（CfnOutput `HomeWorkerRoleArn`）。未指定なら
   * 環境の認証情報をそのまま使う（検証用）。
   */
  roleArn: string | null;
  /**
   * 同時に走らせる録画の上限。既定を2に留めている理由は
   * `README.md`「実機検証の記録」を参照（安全な並列度は冷却状態とホストの
   * 他負荷に依存し、固定の数字では決まらない）。
   */
  maxConcurrency: number;
  /**
   * このワーカーが宣言する追加能力（`@sattori/shared` の `WORKER_CAPABILITIES`）。
   * **実際にできることだけを書く**。
   *
   * 既定は `WORKER_CAPABILITIES` 全部。低速録画（Issue #68）の実体はワーカー
   * コンテナ側（EC2と共通の ECR イメージ）にあり、デーモンは
   * `homeWorkerEnv` をそのまま `docker run` へ渡すだけなので、
   * **イメージが対応していれば自宅ワーカーは無条件に対応できる**——「宣言したのに
   * できない」状態を作りようがないため、明示設定を必須にする意味がない。
   * 逆に「対応しているが引き受けたくない」（録画に倍の実時間がかかるので自宅
   * マシンを長時間占有されたくない等）場合に `HOME_WORKER_CAPABILITIES=`（空）で
   * 降りられるようにしてある。
   */
  capabilities: WorkerCapability[];
  /** 引き受けるタイトル。既定は録画対応タイトル（`SUPPORTED_GAME_IDS`）全部。 */
  supportedGames: GameId[];
  /**
   * オファー用GSIを見に行く間隔（秒）。オファーの待機時間
   * （`apps/api/src/workerRouting.ts` の `offerWindowSeconds`、既定20秒）に対して
   * 十分短くする。
   */
  pollIntervalSec: number;
  /**
   * 1コアあたりのロードアベレージがこの値を超えている間は新規claimを止める
   * （実行中のジョブは止めない）。開発者が自宅マシンを使っている最中に録画を
   * 引き受けて母艦を重くしないためのガード。無効化したい場合は大きな値にする。
   */
  loadThreshold: number;
  /** ワーカーコンテナに与えるCPU数（`docker run --cpus`）。未指定なら制限しない。 */
  dockerCpus: string | null;
  /** `docker run` に追加で渡す引数（`--shm-size=1g` など）。空白区切り。 */
  dockerExtraArgs: string[];
  /**
   * 終了シグナルを受けてから実行中ジョブの完走を待つ上限（秒）。既定は
   * **低速録画（Issue #68）のタイムアウト（120分＝等倍60分の2倍）＋変換の余裕（30分）**
   * で、Step Functions 側のフェイルセーフ（`taskTimeout`、150分）と一致させてある。
   * ここが短いと、AWS側がまだ待っているジョブをデーモンが先に打ち切ることになる。
   */
  drainTimeoutSec: number;
  /**
   * コンテナへ渡す一時認証情報の有効期間（秒）。ロールの `maxSessionDuration`
   * （CDK側で4時間）以下にすること。
   */
  credentialDurationSec: number;
  /**
   * コンテナのネットワーク名前空間からAWSへ実際に到達できるかを確認する間隔
   * （秒）。ホストは正常なのにコンテナだけ通信不能という障害（Issue #160）は
   * ホスト発のハートビートだけでは検知できないため、`docker run`で軽量イメージを
   * 実際に起動して確かめる。失敗している間は新規claimを止める
   * （`daemon.ts#checkNetworkIfDue`）。
   */
  networkCheckIntervalSec: number;
}

/** 環境変数の読み取り元。テストでは擬似的な辞書を渡す。 */
export type Environment = Record<string, string | undefined>;

function required(env: Environment, name: string): string {
  const value = env[name];
  if (value === undefined || value === "") {
    throw new ConfigError(`必須の環境変数 ${name} が設定されていません`);
  }
  return value;
}

function optional(env: Environment, name: string): string | null {
  const value = env[name];
  return value === undefined || value === "" ? null : value;
}

function number_(env: Environment, name: string, fallback: number): number {
  const raw = optional(env, name);
  if (raw === null) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new ConfigError(`環境変数 ${name} は数値である必要があります: ${raw}`);
  }
  return value;
}

function list(env: Environment, name: string): string[] | null {
  const raw = optional(env, name);
  if (raw === null) {
    return null;
  }
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

/**
 * `docker run` へ渡す追加引数を、シェルと同じ規則（空白区切り・引用符・
 * バックスラッシュエスケープ）で分割する。Python版が `shlex.split()` に頼っていた
 * 部分で、`HOME_WORKER_DOCKER_ARGS="--mount type=bind,src=/path with space/..."`
 * のような値を素朴な空白分割で壊さないために必要。
 */
export function splitShellArgs(raw: string): string[] {
  const args: string[] = [];
  let current = "";
  let started = false;
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index] as string;
    if (quote === null && /\s/.test(char)) {
      if (started) {
        args.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    started = true;
    if (quote === null && (char === '"' || char === "'")) {
      quote = char;
      continue;
    }
    if (quote !== null && char === quote) {
      quote = null;
      continue;
    }
    // シングルクォート内ではバックスラッシュもそのままの文字（シェルと同じ）。
    if (char === "\\" && quote !== "'" && index + 1 < raw.length) {
      index += 1;
      current += raw[index] as string;
      continue;
    }
    current += char;
  }
  if (quote !== null) {
    throw new ConfigError(`引用符が閉じていません: ${raw}`);
  }
  if (started) {
    args.push(current);
  }
  return args;
}

/**
 * 対応タイトルの検証。Python版は文字列をそのまま持っていたが、TypeScript版は
 * ハートビート（`WorkerHeartbeat.supportedGames: GameId[]`）の型に載せるため、
 * ここで既知のタイトルかを確かめる。typoで「1件も引き受けないワーカー」が
 * 黙って出来上がるのを起動時に落とせる利点もある。
 */
function parseGames(values: string[]): GameId[] {
  return values.map((value) => {
    if (!(GAME_IDS as readonly string[]).includes(value)) {
      throw new ConfigError(`未知のタイトルです: ${value}`);
    }
    return value as GameId;
  });
}

function parseCapabilities(values: string[]): WorkerCapability[] {
  return values.map((value) => {
    if (!(WORKER_CAPABILITIES as readonly string[]).includes(value)) {
      throw new ConfigError(`未知の能力です: ${value}`);
    }
    return value as WorkerCapability;
  });
}

export function loadConfig(env: Environment = process.env): Config {
  const games = list(env, "HOME_WORKER_SUPPORTED_GAMES");
  // 能力だけは `optional()`（空文字を未設定と同一視する）を通さない。既定が
  // 「全部宣言する」なので、空文字が未設定と同じ扱いだと**降りる手段が無くなる**ため、
  // 「変数そのものが無い＝既定」「空文字＝明示的に何も宣言しない」を区別する。
  const capabilitiesRaw = env["HOME_WORKER_CAPABILITIES"];
  const dockerArgs = optional(env, "HOME_WORKER_DOCKER_ARGS");
  return {
    region: env["AWS_REGION"] || env["AWS_DEFAULT_REGION"] || "eu-south-2",
    jobsTable: required(env, "JOBS_TABLE"),
    workersTable: required(env, "WORKERS_TABLE"),
    logGroup: optional(env, "WORKER_LOG_GROUP") ?? "/sattori/worker",
    workerImage: required(env, "WORKER_IMAGE"),
    workerId: optional(env, "HOME_WORKER_ID") ?? "home-1",
    roleArn: optional(env, "HOME_WORKER_ROLE_ARN"),
    maxConcurrency: number_(env, "HOME_WORKER_MAX_CONCURRENCY", 2),
    capabilities:
      capabilitiesRaw === undefined
        ? [...WORKER_CAPABILITIES]
        : parseCapabilities(
            capabilitiesRaw
              .split(",")
              .map((item) => item.trim())
              .filter((item) => item !== ""),
          ),
    // 録画対応タイトル（`SUPPORTED_GAME_IDS`）を既定にする。自宅マシンの都合で
    // 一部だけ受け持ちたい場合は `HOME_WORKER_SUPPORTED_GAMES` で上書きする。
    supportedGames: games === null ? [...SUPPORTED_GAME_IDS] : parseGames(games),
    pollIntervalSec: number_(env, "HOME_WORKER_POLL_INTERVAL_SEC", 3),
    loadThreshold: number_(env, "HOME_WORKER_LOAD_THRESHOLD", 0.7),
    dockerCpus: optional(env, "HOME_WORKER_DOCKER_CPUS"),
    dockerExtraArgs: dockerArgs === null ? [] : splitShellArgs(dockerArgs),
    drainTimeoutSec: number_(env, "HOME_WORKER_DRAIN_TIMEOUT_SEC", 150 * 60),
    credentialDurationSec: number_(env, "HOME_WORKER_CREDENTIAL_DURATION_SEC", 4 * 60 * 60),
    networkCheckIntervalSec: number_(env, "HOME_WORKER_NETWORK_CHECK_INTERVAL_SEC", 60),
  };
}
