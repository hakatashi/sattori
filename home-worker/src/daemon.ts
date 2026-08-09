/**
 * 自宅サーバーを追加の録画ワーカーとして動かす常駐デーモン（Issue #49）。
 *
 * 自宅マシンは動的グローバルIP・NAT配下でAWS側から到達できないため、
 * **AWSが自宅を叩くのではなく、自宅がジョブを取りに行くPull型**にしている。
 * 1周ごとに:
 *
 *   1. 自身の空き状況を `WorkersTable` へハートビートとして書く。
 *   2. 余力があれば、オファー中のジョブ（sparse GSI `HomeWorkerOfferIndex`）を探し、
 *      条件付き更新で原子的にclaimする。
 *   3. claimできたらワーカーコンテナ（EC2と同一のECRイメージ）を起動し、その出力を
 *      CloudWatch Logs へ転送する。録画の成否はコンテナ自身が taskToken 経由で
 *      Step Functions へ通知するので、このデーモンは通知に関与しない
 *      （コンテナが起動すらできなかった場合の失敗通知だけは肩代わりする）。
 *
 * 実行中は30秒ごとに「claimがまだ自分のものか」を条件付き更新で確かめる。
 * AWS側（`HandleFailure`・管理画面からの緊急停止）が `assignedWorkerId` を消すことが
 * **claimの取り消し**なので、条件が崩れたら即座にコンテナを停止する。これを怠ると、
 * 既に別経路でリトライが始まっているジョブを二重に録画してしまう。
 *
 * SIGTERM/SIGINT を受けたら新規claimを止め、実行中のジョブは完走を待ってから終了する
 * （走り出した録画を落とすと、節約できるCPU時間よりはるかに大きな無駄になるため）。
 *
 * 起動方法・IAM設定・systemdユニットの例は `home-worker/README.md` を参照。
 */
import { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { ECRClient } from "@aws-sdk/client-ecr";
import { SendTaskFailureCommand, SFNClient } from "@aws-sdk/client-sfn";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { WORKER_HEARTBEAT_INTERVAL_SECONDS } from "@sattori/shared";
import type { JobRecord, WorkerEnvironment } from "@sattori/shared";
import { canAccept, loadPerCpu } from "./capacity.js";
import { claimJob, clearWorkerEnv, findOpenOffers, releaseClaim, touchClaim } from "./claim.js";
import type { Config } from "./config.js";
import { CredentialProvider } from "./credentials.js";
import type { CredentialSource, TemporaryCredentials } from "./credentials.js";
import { publishHeartbeat as writeHeartbeat } from "./heartbeat.js";
import { CloudWatchLogShipper } from "./logShipper.js";
import { ContainerRun, ImagePreparationError, ecrLogin, pullImage } from "./runner.js";
import type { Killable, RunCommand, SpawnContainer } from "./runner.js";
import { Signal, sleep } from "./signal.js";

/**
 * 実行中ジョブのclaimが自分のものか確認する間隔（秒）。取り消しの検知が遅れるほど
 * 二重録画の窓が広がるので、短めにする（DynamoDBの更新1回ぶんの負荷しかない）。
 */
export const CLAIM_CHECK_INTERVAL_SEC = 30;

/** ドレイン中にジョブの終了を待ち合わせる間隔（ミリ秒）。 */
const DRAIN_POLL_INTERVAL_MS = 1000;

export function log(message: string): void {
  const now = new Date();
  const time = [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
  console.log(`[home-worker ${time}] ${message}`);
}

export interface DaemonDeps {
  credentials?: CredentialSource;
  log?: (message: string) => void;
  /** テスト用: claim確認の間隔を縮めるための差し替え。 */
  claimCheckIntervalSec?: number;
  /** テスト用: ロードアベレージの差し替え。 */
  loadPerCpu?: () => number;
  /** テスト用: `docker` の起動を差し替える。 */
  runCommand?: RunCommand;
  spawnContainer?: SpawnContainer;
}

export class HomeWorkerDaemon {
  readonly #config: Config;
  readonly #log: (message: string) => void;
  readonly #credentials: CredentialSource;
  readonly #claimCheckIntervalMs: number;
  readonly #loadPerCpu: () => number;
  readonly #runnerOptions: { log: (message: string) => void; run?: RunCommand; spawnContainer?: SpawnContainer };
  readonly #stopping = new Signal();
  /** jobId -> 実行中コンテナ（起動前は null のスロット予約）。 */
  readonly #running = new Map<string, Killable | null>();
  /** 実行中ジョブの完了を待ち合わせるためのプロミス集合（ドレイン用）。 */
  readonly #jobPromises = new Set<Promise<void>>();
  #lastHeartbeatAtMs = 0;
  #documents: DynamoDBDocumentClient | undefined;
  #logs: CloudWatchLogsClient | undefined;
  #ecr: ECRClient | undefined;
  #sfn: SFNClient | undefined;

  constructor(config: Config, deps: DaemonDeps = {}) {
    this.#config = config;
    this.#log = deps.log ?? log;
    this.#credentials =
      deps.credentials ??
      new CredentialProvider({
        region: config.region,
        roleArn: config.roleArn,
        durationSec: config.credentialDurationSec,
        log: this.#log,
      });
    this.#claimCheckIntervalMs = (deps.claimCheckIntervalSec ?? CLAIM_CHECK_INTERVAL_SEC) * 1000;
    this.#loadPerCpu = deps.loadPerCpu ?? ((): number => loadPerCpu());
    this.#runnerOptions = {
      log: this.#log,
      ...(deps.runCommand === undefined ? {} : { run: deps.runCommand }),
      ...(deps.spawnContainer === undefined ? {} : { spawnContainer: deps.spawnContainer }),
    };
  }

  // --- AWSクライアント -----------------------------------------------------
  // 認証情報は期限付きだが、`CredentialProvider` がSDKのプロバイダ関数として
  // 期限管理を引き受けるため、クライアント自体は使い回してよい。

  #clientConfig(): { region: string; credentials?: () => Promise<TemporaryCredentials> } {
    const credentials = this.#credentials.clientCredentials();
    return credentials === undefined
      ? { region: this.#config.region }
      : { region: this.#config.region, credentials };
  }

  #documentClient(): DynamoDBDocumentClient {
    this.#documents ??= DynamoDBDocumentClient.from(new DynamoDBClient(this.#clientConfig()));
    return this.#documents;
  }

  #logsClient(): CloudWatchLogsClient {
    this.#logs ??= new CloudWatchLogsClient(this.#clientConfig());
    return this.#logs;
  }

  #ecrClient(): ECRClient {
    this.#ecr ??= new ECRClient(this.#clientConfig());
    return this.#ecr;
  }

  #sfnClient(): SFNClient {
    this.#sfn ??= new SFNClient(this.#clientConfig());
    return this.#sfn;
  }

  // --- メインループ ---------------------------------------------------------

  stop(): void {
    this.#stopping.set();
  }

  activeJobs(): number {
    return this.#running.size;
  }

  async runForever(): Promise<void> {
    this.#log(
      `起動しました workerId=${this.#config.workerId} ` +
        `maxConcurrency=${this.#config.maxConcurrency} ` +
        `games=${this.#config.supportedGames.join(",")} ` +
        `capabilities=${this.#config.capabilities.join(",") || "(なし)"}`,
    );
    while (!this.#stopping.isSet) {
      try {
        await this.tick();
      } catch (err) {
        // 一時的なAPI障害でデーモンを落とさない。
        this.#log(`ループでエラーが発生しました(継続): ${String(err)}`);
      }
      await this.#stopping.wait(this.#config.pollIntervalSec * 1000);
    }
    await this.drain();
  }

  /** メインループの1周ぶん（テストから直接呼べるように公開している）。 */
  async tick(): Promise<void> {
    const active = this.activeJobs();
    const load = this.#loadPerCpu();
    const accepting = !this.#stopping.isSet && canAccept(this.#config, active, load);
    await this.publishHeartbeat(accepting, active);
    if (!accepting) {
      return;
    }
    for (const job of await this.claimOffers(this.#config.maxConcurrency - active)) {
      this.startJob(job);
    }
  }

  /**
   * ハートビートを書く（前回から `WORKER_HEARTBEAT_INTERVAL_SECONDS` 経っていなければ
   * 何もしない）。ポーリング間隔（既定3秒）とハートビート間隔（15秒）は別物なので、
   * 毎周書かないよう間引く。
   */
  async publishHeartbeat(accepting: boolean, activeJobs: number): Promise<void> {
    const now = Date.now();
    if (now - this.#lastHeartbeatAtMs < WORKER_HEARTBEAT_INTERVAL_SECONDS * 1000) {
      return;
    }
    await writeHeartbeat(this.#documentClient(), this.#config.workersTable, this.#config, {
      accepting,
      activeJobs,
    });
    this.#lastHeartbeatAtMs = now;
  }

  /**
   * オファーを探索し、引き受けられるものを空きスロットぶんだけclaimする。
   * claimできたジョブレコード（`homeWorkerEnv` を含む）を返す。
   */
  async claimOffers(availableSlots: number): Promise<JobRecord[]> {
    const claimed: JobRecord[] = [];
    if (availableSlots <= 0) {
      return claimed;
    }
    const client = this.#documentClient();
    for (const offer of await findOpenOffers(client, this.#config.jobsTable)) {
      if (claimed.length >= availableSlots || this.#stopping.isSet) {
        break;
      }
      if (typeof offer.jobId !== "string" || !this.#config.supportedGames.includes(offer.game)) {
        continue;
      }
      const job = await claimJob(client, this.#config.jobsTable, offer.jobId, this.#config.workerId);
      if (job === null) {
        // 他のワーカーが先に取ったか、期限切れ。次のオファーへ。
        continue;
      }
      this.#log(`ジョブをclaimしました jobId=${offer.jobId} game=${offer.game}`);
      claimed.push(job);
    }
    return claimed;
  }

  /**
   * ジョブの実行を開始する（完了は待たない）。実行中の数え上げはコンテナ起動前から
   * 効かせたいので、スロットの予約（値 null）をここで入れる。
   */
  startJob(job: JobRecord): void {
    this.#running.set(job.jobId, null);
    const promise = this.#runJob(job)
      .catch((err: unknown) => {
        // `#runJob` は自前で握りつぶすが、二重の保険（未処理のPromise拒否で
        // プロセスを落とさない）。
        this.#log(`ジョブの後始末で予期しないエラー jobId=${job.jobId}: ${String(err)}`);
      })
      .finally(() => {
        this.#running.delete(job.jobId);
        this.#jobPromises.delete(promise);
      });
    this.#jobPromises.add(promise);
  }

  // --- ジョブ1本の実行 ------------------------------------------------------

  async #runJob(job: JobRecord): Promise<void> {
    const jobId = job.jobId;
    const shipper = new CloudWatchLogShipper(
      this.#logsClient(),
      this.#config.logGroup,
      jobId,
      { log: this.#log },
    );
    /** 監視ループを起こすためのジョブ完了シグナル。 */
    const finished = new Signal();
    try {
      const offered = job.homeWorkerEnv;
      if (offered === undefined || Object.keys(offered).length === 0) {
        throw new ImagePreparationError("オファーにワーカー環境変数が含まれていません");
      }
      // EC2のインスタンスプロファイルに相当する認証情報をコンテナへ渡す。
      const env: Record<string, string> = {
        ...offered,
        ...(await this.#credentials.containerEnv()),
      };

      await ecrLogin(this.#ecrClient(), this.#config.workerImage, this.#runnerOptions);
      await pullImage(this.#config.workerImage, this.#runnerOptions);

      const container = new ContainerRun(this.#config, jobId, env, this.#runnerOptions);
      this.#running.set(jobId, container);
      void this.watchClaim(jobId, container, finished);

      const exitCode = await container.run((line) => {
        shipper.append(line);
      });
      await shipper.flush();
      await this.#finishJob(job, env, container, exitCode);
    } catch (err) {
      // コンテナを一度も起動できなかった＝ワーカー内部の失敗通知が走らない。
      // EC2のUserDataが bootstrap 失敗を自分で通知するのと同じ役割を果たす。
      const bootstrapFailure = err instanceof ImagePreparationError;
      this.#log(
        bootstrapFailure
          ? `ジョブを開始できませんでした jobId=${jobId}: ${String(err)}`
          : `ジョブの実行中にエラーが発生しました jobId=${jobId}: ${String(err)}`,
      );
      await this.#notifyFailure(
        job.homeWorkerEnv,
        bootstrapFailure ? "HomeWorkerBootstrapFailure" : "HomeWorkerFailed",
        String(err),
      );
      await releaseClaim(
        this.#documentClient(),
        this.#config.jobsTable,
        jobId,
        this.#config.workerId,
      );
    } finally {
      finished.set();
      await shipper.flush();
      this.#running.delete(jobId);
    }
  }

  async #finishJob(
    job: JobRecord,
    env: Record<string, string>,
    container: ContainerRun,
    exitCode: number,
  ): Promise<void> {
    const jobId = job.jobId;
    if (container.killed) {
      // claim取り消しによる停止。Step Functions側は既に別経路で処理を進めて
      // いるため、ここから成否を通知してはいけない。
      this.#log(`claimが取り消されたためコンテナを停止しました jobId=${jobId}`);
      return;
    }

    this.#log(`コンテナが終了しました jobId=${jobId} exitCode=${exitCode}`);
    if (exitCode !== 0) {
      // 通常はワーカー自身（entrypoint.py）が失敗を通知済みで、この通知は
      // 消費済みトークンへの空振りになる。OOM killのようにワーカーが自分で
      // 通知する間もなく落ちた場合の保険としてだけ意味がある。
      await this.#notifyFailure(
        env,
        "HomeWorkerContainerFailed",
        `container exited with ${exitCode}`,
      );
    }
    // 使用済みtaskTokenをジョブレコードに残さない。
    await clearWorkerEnv(
      this.#documentClient(),
      this.#config.jobsTable,
      jobId,
      this.#config.workerId,
    );
  }

  async #notifyFailure(
    env: WorkerEnvironment | undefined,
    error: string,
    cause: string,
  ): Promise<void> {
    const token = env?.["TASK_TOKEN"];
    if (token === undefined || token === "") {
      return;
    }
    try {
      await this.#sfnClient().send(
        new SendTaskFailureCommand({
          taskToken: token,
          error,
          cause: cause.slice(0, 32000),
        }),
      );
    } catch (err) {
      // 消費済みトークンなら失敗して当然。
      this.#log(`taskTokenへの失敗通知をスキップしました: ${String(err)}`);
    }
  }

  /**
   * claimが自分のものであり続けるかを見張り、崩れたらコンテナを停止する。
   * `finished` はジョブ側が終了時に立てるシグナルで、これが無いと最大
   * `CLAIM_CHECK_INTERVAL_SEC` ぶん監視ループが残り続ける。
   */
  async watchClaim(jobId: string, container: Killable, finished: Signal): Promise<void> {
    while (!container.killed && !finished.isSet) {
      await finished.wait(this.#claimCheckIntervalMs);
      if (container.killed || finished.isSet) {
        return;
      }
      let stillMine: boolean;
      try {
        stillMine = await touchClaim(
          this.#documentClient(),
          this.#config.jobsTable,
          jobId,
          this.#config.workerId,
        );
      } catch (err) {
        // 一時的なAPI障害では止めない（止めるほうが損失が大きい）。
        this.#log(`claimの確認に失敗しました(継続) jobId=${jobId}: ${String(err)}`);
        continue;
      }
      if (!stillMine) {
        this.#log(`claimが取り消されました。コンテナを停止します jobId=${jobId}`);
        await container.kill();
        return;
      }
    }
  }

  // --- 終了処理 -------------------------------------------------------------

  /** 新規claimを止めた状態で、実行中ジョブの完走を待つ。 */
  async drain(): Promise<void> {
    const active = this.activeJobs();
    if (active === 0) {
      this.#log("実行中のジョブはありません。終了します");
      return;
    }
    this.#log(`${active}件のジョブの完走を待ちます(最大${Math.floor(this.#config.drainTimeoutSec)}秒)`);
    const deadline = Date.now() + this.#config.drainTimeoutSec * 1000;
    while (this.activeJobs() > 0 && Date.now() < deadline) {
      // ドレイン中も「受付停止」のハートビートは出し続ける。止めてしまうと
      // AWS側からは落ちたように見え、実行中ジョブのclaimを解除されかねない。
      try {
        await this.publishHeartbeat(false, this.activeJobs());
      } catch (err) {
        this.#log(`ドレイン中のハートビートに失敗しました(継続): ${String(err)}`);
      }
      await Promise.race([
        Promise.allSettled([...this.#jobPromises]),
        sleep(DRAIN_POLL_INTERVAL_MS),
      ]);
    }
    const remaining = this.activeJobs();
    if (remaining > 0) {
      this.#log(`待機時間を超過しました。${remaining}件のジョブを残して終了します`);
    }
  }
}
