/**
 * ワーカーコンテナ（ECRの `sattori-worker` イメージ）の実行（Issue #49）。
 *
 * **EC2ワーカーとまったく同じイメージを、まったく同じ環境変数で動かす**のが要点。
 * 環境変数はAWS側（`apps/api/src/workerEnv.ts`）が組み立ててオファーに添えたものを
 * そのまま渡すだけで、このデーモンは中身を解釈しない。ワーカー内のロジックに
 * 「自宅かEC2か」の分岐を持ち込まないための構造で、1/2倍速録画（Issue #68）のような
 * 自宅限定の挙動も、起動側が渡す環境変数の違いとして表現される。
 *
 * EC2との違いは、コンテナに渡すAWS認証情報（インスタンスプロファイルが無いため
 * `credentials.ts` が発行した一時認証情報を環境変数で渡す）と、ログの送り方
 * （`logShipper.ts`）の2点だけ。
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { GetAuthorizationTokenCommand } from "@aws-sdk/client-ecr";
import type { ECRClient } from "@aws-sdk/client-ecr";
import type { Config } from "./config.js";

/**
 * `docker run --name` に付ける接頭辞。`docker ps` で自宅の録画コンテナだけを
 * 見分けられるようにする（claim取り消し時の `docker kill` もこの名前で行う）。
 */
export const CONTAINER_NAME_PREFIX = "sattori-job-";

/** ECRログイン・イメージpullの再試行回数（EC2のUserDataと揃える）。 */
export const RETRY_COUNT = 3;

/** ECRログインまたはイメージpullに失敗した（=コンテナを起動できない）。 */
export class ImagePreparationError extends Error {
  override readonly name = "ImagePreparationError";
}

export function containerName(jobId: string): string {
  return `${CONTAINER_NAME_PREFIX}${jobId}`;
}

export function registryOf(image: string): string {
  return image.split("/")[0] ?? image;
}

/** 外部コマンドの実行結果。 */
export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** 外部コマンドを1回実行して完了を待つ（テストでは差し替える）。 */
export type RunCommand = (
  command: string[],
  options?: { input?: string },
) => Promise<CommandResult>;

/**
 * コンテナを起動し、標準出力・標準エラーの各行を `onLine` へ渡して、
 * 終了コードで解決する（テストでは差し替える）。
 */
export type SpawnContainer = (
  command: string[],
  onLine: (line: string) => void,
) => Promise<number>;

export const defaultRunCommand: RunCommand = async (command, options) => {
  const [file, ...args] = command;
  if (file === undefined) {
    throw new Error("実行するコマンドが空です");
  }
  return await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(file, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code: code ?? -1, stdout, stderr });
    });
    // 子プロセスが書き込みより先に死ぬと `stdin` は EPIPE を投げる。リスナが
    // 無ければ Node はこれを未処理の 'error' イベントとして扱い、**デーモン全体を
    // 落とす**（Python版の `subprocess.run(input=...)` はここを内部で吸収していた）。
    // 実際の失敗は `close` の終了コードと stderr で分かるので、ここでは捨ててよい。
    child.stdin.on("error", () => undefined);
    child.stdout.on("error", () => undefined);
    child.stderr.on("error", () => undefined);
    child.stdin.end(options?.input ?? "");
  });
};

export const defaultSpawnContainer: SpawnContainer = async (command, onLine) => {
  const [file, ...args] = command;
  if (file === undefined) {
    throw new Error("実行するコマンドが空です");
  }
  const child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"] });
  // Python版は `stderr=STDOUT` でマージしていたが、Nodeでは2本のストリームを
  // それぞれ行単位で読んで同じ転送先へ流すほうが素直（CloudWatch Logsの
  // 1ストリームへ入る点は同じ）。
  const readers = [child.stdout, child.stderr].map(async (stream) => {
    try {
      for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
        onLine(line);
      }
    } catch (err) {
      // 子プロセスの異常終了でストリーム自体が壊れることはある。読めた行までで
      // 打ち切る（成否は `close` の終了コードで判断する）。ここで拒否させると、
      // spawn自体が失敗した場合に**誰も待たないPromiseの拒否**になり、デーモンが
      // 落ちる。
      onLine(`[runner] コンテナ出力の読み取りが中断されました: ${String(err)}`);
    }
  });
  try {
    return await new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (exitCode) => {
        resolve(exitCode ?? -1);
      });
    });
  } finally {
    await Promise.all(readers);
  }
};

/**
 * `docker run` のコマンドライン。
 *
 * 環境変数には taskToken と一時認証情報が含まれるため、**この戻り値をそのまま
 * ログへ出してはいけない**（ログ用には `redactCommand()` を使う）。
 */
export function buildDockerCommand(
  config: Config,
  jobId: string,
  env: Record<string, string>,
): string[] {
  const cmd = ["docker", "run", "--rm", "--name", containerName(jobId)];
  if (config.dockerCpus !== null) {
    cmd.push("--cpus", config.dockerCpus);
  }
  cmd.push(...config.dockerExtraArgs);
  for (const key of Object.keys(env).sort()) {
    cmd.push("-e", `${key}=${env[key] ?? ""}`);
  }
  cmd.push(config.workerImage);
  return cmd;
}

/** 値をログに出してはいけない環境変数。 */
export const SECRET_ENV_KEYS: ReadonlySet<string> = new Set([
  "TASK_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
]);

/** `buildDockerCommand()` の結果から秘密値を伏せたコピー（ログ用）。 */
export function redactCommand(command: string[]): string[] {
  return command.map((item) => {
    const separator = item.indexOf("=");
    if (separator < 0) {
      return item;
    }
    const key = item.slice(0, separator);
    return SECRET_ENV_KEYS.has(key) ? `${key}=***` : item;
  });
}

export interface RunnerOptions {
  log?: (message: string) => void;
  run?: RunCommand;
  spawnContainer?: SpawnContainer;
}

/**
 * ECRへ `docker login` する。トークンは12時間有効だがジョブ毎に取り直す
 * （取得は安価で、期限管理を持ち込むより単純）。
 */
export async function ecrLogin(
  ecr: ECRClient,
  image: string,
  options: RunnerOptions = {},
): Promise<void> {
  const log = options.log ?? ((message: string): void => console.log(message));
  const run = options.run ?? defaultRunCommand;
  const result = await ecr.send(new GetAuthorizationTokenCommand({}));
  const token = result.authorizationData?.[0]?.authorizationToken;
  if (token === undefined) {
    throw new ImagePreparationError("ECRの認証トークンを取得できませんでした");
  }
  const decoded = Buffer.from(token, "base64").toString();
  const separator = decoded.indexOf(":");
  const user = separator < 0 ? decoded : decoded.slice(0, separator);
  const password = separator < 0 ? "" : decoded.slice(separator + 1);
  const login = await run(
    ["docker", "login", "--username", user, "--password-stdin", registryOf(image)],
    { input: password },
  );
  if (login.code !== 0) {
    throw new ImagePreparationError(`docker login に失敗しました: ${login.stderr.trim()}`);
  }
  log("[runner] ECRへログインしました");
}

export async function pullImage(image: string, options: RunnerOptions = {}): Promise<void> {
  const log = options.log ?? ((message: string): void => console.log(message));
  const run = options.run ?? defaultRunCommand;
  for (let attempt = 1; attempt <= RETRY_COUNT; attempt += 1) {
    const result = await run(["docker", "pull", image]);
    if (result.code === 0) {
      return;
    }
    log(`[runner] docker pull 失敗(試行${attempt}回目): ${result.stderr.trim()}`);
  }
  throw new ImagePreparationError(`docker pull に${RETRY_COUNT}回失敗しました: ${image}`);
}

/**
 * claim取り消し時に止められる実行単位。デーモンの claim 監視は
 * `ContainerRun` の実体ではなくこのインターフェースにだけ依存する。
 */
export interface Killable {
  readonly killed: boolean;
  kill(): Promise<void>;
}

/**
 * 1ジョブぶんのコンテナ実行。`run()` は完了まで待ち、`kill()` は
 * claim取り消しを検知した監視ループから割り込みで呼ばれる。
 */
export class ContainerRun implements Killable {
  readonly #config: Config;
  readonly #jobId: string;
  readonly #env: Record<string, string>;
  readonly #log: (message: string) => void;
  readonly #run: RunCommand;
  readonly #spawnContainer: SpawnContainer;
  #killed = false;

  constructor(
    config: Config,
    jobId: string,
    env: Record<string, string>,
    options: RunnerOptions = {},
  ) {
    this.#config = config;
    this.#jobId = jobId;
    this.#env = env;
    this.#log = options.log ?? ((message): void => console.log(message));
    this.#run = options.run ?? defaultRunCommand;
    this.#spawnContainer = options.spawnContainer ?? defaultSpawnContainer;
  }

  get killed(): boolean {
    return this.#killed;
  }

  /** コンテナを起動し、出力の各行を `onLine` へ渡す。終了コードを返す。 */
  async run(onLine: (line: string) => void): Promise<number> {
    const cmd = buildDockerCommand(this.#config, this.#jobId, this.#env);
    this.#log(`[runner] コンテナを起動します: ${redactCommand(cmd).join(" ")}`);
    return await this.#spawnContainer(cmd, onLine);
  }

  /**
   * コンテナを停止する。claimが取り消された（=別経路でリトライが始まった）
   * ときに呼ぶ。放置すると同じリプレイを二重に録画してしまう。
   *
   * **`killed` を立てるのは実際に止められたときだけ**。`docker kill` は
   * dockerデーモンの一時障害でも失敗しうるが、失敗を無視して停止済みとして扱うと、
   * 生き残ったコンテナがそのまま録画を完走する一方で `#finishJob` が
   * 「claim取り消しによる停止」として通知もログも省いてしまい、二重録画が
   * 誰にも気づかれない。呼び出し側が再試行できるよう例外にする。
   */
  async kill(): Promise<void> {
    const result = await this.#run(["docker", "kill", containerName(this.#jobId)]);
    if (result.code !== 0) {
      throw new Error(
        `docker kill に失敗しました(exit=${result.code}): ${result.stderr.trim()}`,
      );
    }
    this.#killed = true;
  }
}
