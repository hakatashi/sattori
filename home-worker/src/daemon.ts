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
 * **claimの取り消しをどう確実に捕捉するか**がこのデーモンの中心的な関心事である。
 * AWS側（`HandleFailure`・管理画面からの緊急停止）が `assignedWorkerId` を消すことが
 * 取り消しであり、これを取りこぼすと、既に別経路でリトライが始まっているジョブを
 * 二重に録画してしまう。NAT配下で通知を受け取れないため、捕捉は次の3点で行う:
 *
 *   1. 実行中は `CLAIM_CHECK_INTERVAL_SEC` ごとに「claimがまだ自分のものか」を
 *      条件付き更新（`touchClaim`）で確かめる。**コンテナを起動する前から**回すので、
 *      イメージのpull中に取り消された場合はコンテナを起動せずに終わる。
 *   2. **実行中のジョブと同じjobIdがオファーに再出現したら、その場で権威のある
 *      確認を行う**。オファーは `attribute_not_exists(assignedWorkerId)` を条件に
 *      書かれるので、再出現は取り消しの強い兆候である（GSIは結果整合なので断定は
 *      できず、必ず `touchClaim` で裏を取る）。ポーリング間隔を待たずに気づける。
 *   3. 実行中のジョブは**二度claimしない**。claimし直すと同名コンテナの起動失敗で
 *      リトライを1回無駄に消費し、スロットの数え上げも壊れる。
 *
 * 取り消しを検知したら `docker kill` する。**killの失敗は握りつぶさない**
 * （成功するまで再試行し、成功しない限り「停止済み」として扱わない）——止められて
 * いないコンテナを止めたことにすると、二重録画が誰にも気づかれないまま完走する。
 *
 * なお、コンテナが完走してしまった場合の後始末（`done`への上書きや完了メール）は
 * ジョブレコード側の拒否票（`JobRecord.stopRequestedAt`）が受け止める。
 *
 * SIGTERM/SIGINT を受けたら新規claimを止め、実行中のジョブは完走を待ってから終了する
 * （走り出した録画を落とすと、節約できるCPU時間よりはるかに大きな無駄になるため）。
 *
 * 起動方法・IAM設定・systemdユニットの例は `docs/runbooks/home-worker-setup.md` を参照。
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

/** claimが取り消されたため実行を中止した（＝失敗として通知してはいけない）。 */
class ClaimRevokedError extends Error {
  override readonly name = "ClaimRevokedError";
}

/**
 * claim監視ループが見張る対象。claimの取り消しは**コンテナを起動する前**にも
 * 起こりうるため、コンテナの実体とは別に取り消しフラグを持つ。
 */
export interface ClaimWatchTarget {
  /** claimの取り消しを検知した（コンテナ起動前を含む）。 */
  readonly revoked: Signal;
  /** ジョブの実行が終わった（成否は問わない）。監視ループを起こすために使う。 */
  readonly finished: Signal;
  /** 起動済みコンテナ（起動前・起動できなかった場合は null）。 */
  container: Killable | null;
}

/** 実行中のジョブ1件ぶんの状態。 */
class RunningJob implements ClaimWatchTarget {
  readonly revoked = new Signal();
  readonly finished = new Signal();
  container: Killable | null = null;
  /** `#runJob` の完了を待ち合わせるためのプロミス（ドレイン用）。 */
  promise: Promise<void> = Promise.resolve();
}

export class HomeWorkerDaemon {
  readonly #config: Config;
  readonly #log: (message: string) => void;
  readonly #credentials: CredentialSource;
  readonly #claimCheckIntervalMs: number;
  readonly #loadPerCpu: () => number;
  readonly #runnerOptions: { log: (message: string) => void; run?: RunCommand; spawnContainer?: SpawnContainer };
  readonly #stopping = new Signal();
  /** jobId -> 実行中ジョブ（claim直後、コンテナ起動前から登録する）。 */
  readonly #running = new Map<string, RunningJob>();
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
    const claimed = await this.claimAndStartOffers(this.#config.maxConcurrency - active);
    if (claimed.length > 0) {
      // claim直後に空き状況を書き直す。間引き（15秒）に任せると、スロットが埋まった
      // 後も最大15秒間AWSからは「空きあり」に見え、誰もclaimできないジョブが
      // オファーされて、EC2へのフォールバックが`offerWindowSeconds`ぶん遅れる。
      const remaining = this.activeJobs();
      await this.publishHeartbeat(
        !this.#stopping.isSet && canAccept(this.#config, remaining, load),
        remaining,
        { force: true },
      );
    }
  }

  /**
   * ハートビートを書く（前回から `WORKER_HEARTBEAT_INTERVAL_SECONDS` 経っていなければ
   * 何もしない）。ポーリング間隔（既定3秒）とハートビート間隔（15秒）は別物なので、
   * 毎周書かないよう間引く。
   *
   * `force` を渡すと間引きを無視して即座に書く。空き状況が変わった瞬間
   * （claim直後）は、AWS側の判断材料が古いままだと無駄なオファーを招くため。
   */
  async publishHeartbeat(
    accepting: boolean,
    activeJobs: number,
    options: { force?: boolean } = {},
  ): Promise<void> {
    const now = Date.now();
    if (
      options.force !== true &&
      now - this.#lastHeartbeatAtMs < WORKER_HEARTBEAT_INTERVAL_SECONDS * 1000
    ) {
      return;
    }
    await writeHeartbeat(this.#documentClient(), this.#config.workersTable, this.#config, {
      accepting,
      activeJobs,
    });
    this.#lastHeartbeatAtMs = now;
  }

  /**
   * オファーを探索し、引き受けられるものを空きスロットぶんだけclaimして**その場で
   * 実行を開始する**。claimしたジョブレコード（`homeWorkerEnv` を含む）を返す。
   *
   * claimと起動を1件ずつ交互に行うのが要点。claimを溜めてからまとめて起動すると、
   * 2件目のclaimがDynamoDBの一時障害で例外になったときに、**1件目のclaimだけが
   * 誰にも実行されないまま**残る（AWS側は割り当て済みと見えるのでEC2も起動せず、
   * ジョブは15分のハートビートタイムアウトまで凍る）。
   *
   * claim自体が例外になった場合は、応答が失われただけで**書き込みは成功している
   * 可能性がある**ため、自分名義のclaimを解除してから打ち切る（`releaseClaim` は
   * 自分が持っている場合しか効かない条件付き更新なので、空振りでも無害）。
   */
  async claimAndStartOffers(availableSlots: number): Promise<JobRecord[]> {
    const claimed: JobRecord[] = [];
    if (availableSlots <= 0) {
      return claimed;
    }
    const client = this.#documentClient();
    for (const offer of await findOpenOffers(client, this.#config.jobsTable)) {
      if (claimed.length >= availableSlots || this.#stopping.isSet) {
        break;
      }
      const jobId = offer.jobId;
      if (typeof jobId !== "string" || !this.#config.supportedGames.includes(offer.game)) {
        continue;
      }
      const running = this.#running.get(jobId);
      if (running !== undefined) {
        // 実行中のジョブが再びオファーに載っている＝AWS側が割り当てを解除して
        // 出し直した可能性が高い。**二度claimしてはならない**（同名コンテナの
        // 起動失敗でリトライを1回無駄にし、スロットの数え上げも壊れる）。
        // GSIは結果整合なので自分のclaim直後の残像でもありうるため、権威のある
        // 条件付き更新で裏を取る。
        await this.#recheckClaim(jobId, running);
        continue;
      }
      let job: JobRecord | null;
      try {
        job = await claimJob(client, this.#config.jobsTable, jobId, this.#config.workerId);
      } catch (err) {
        this.#log(`claimに失敗しました(打ち切り) jobId=${jobId}: ${String(err)}`);
        await this.#releaseUncertainClaim(jobId);
        break;
      }
      if (job === null) {
        // 他のワーカーが先に取ったか、期限切れ。次のオファーへ。
        continue;
      }
      this.#log(`ジョブをclaimしました jobId=${jobId} game=${offer.game}`);
      claimed.push(job);
      this.startJob(job);
    }
    return claimed;
  }

  /**
   * claimの成否が不明なまま例外になったジョブの後始末。書き込みが通っていた場合の
   * 「実行されないclaim」を残さないため、自分名義なら解除する。
   */
  async #releaseUncertainClaim(jobId: string): Promise<void> {
    try {
      await releaseClaim(this.#documentClient(), this.#config.jobsTable, jobId, this.#config.workerId);
    } catch (err) {
      this.#log(`claimの取り消しにも失敗しました jobId=${jobId}: ${String(err)}`);
    }
  }

  /**
   * ジョブの実行を開始する（完了は待たない）。実行中の数え上げ・claim監視は
   * コンテナ起動前から効かせたいので、スロットの予約をここで入れる。
   */
  startJob(job: JobRecord): void {
    const running = new RunningJob();
    this.#running.set(job.jobId, running);
    running.promise = this.#runJob(job, running)
      .catch((err: unknown) => {
        // `#runJob` は自前で握りつぶすが、二重の保険（未処理のPromise拒否で
        // プロセスを落とさない）。
        this.#log(`ジョブの後始末で予期しないエラー jobId=${job.jobId}: ${String(err)}`);
      })
      .finally(() => {
        this.#running.delete(job.jobId);
      });
  }

  // --- ジョブ1本の実行 ------------------------------------------------------

  async #runJob(job: JobRecord, running: RunningJob): Promise<void> {
    const jobId = job.jobId;
    const shipper = new CloudWatchLogShipper(
      this.#logsClient(),
      this.#config.logGroup,
      jobId,
      { log: this.#log },
    );
    // claimの監視はコンテナ起動より先に始める。イメージのpullには数分かかることが
    // あり、その間に取り消されたなら**コンテナを起動しない**のが正しい。
    void this.watchClaim(jobId, running).catch((err: unknown) => {
      // 監視ループの内部は自前で握りつぶすが、ここを裸の `void` にすると
      // 想定外の拒否ひとつでプロセスが落ち、実行中の全録画が道連れになる。
      this.#log(`claim監視ループで予期しないエラー jobId=${jobId}: ${String(err)}`);
    });
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
      // **登録してから取り消しを確認する**順序が要点。逆にすると「確認は通ったが
      // 登録前に取り消された」窓ができ、監視ループはkillすべき相手を知らないまま
      // コンテナが走り出す。この順序なら、pull中の取り消しはここで（コンテナを
      // 起動せずに）拾い、起動後の取り消しは監視ループが `docker kill` で拾う。
      running.container = container;
      if (running.revoked.isSet) {
        throw new ClaimRevokedError("claimが取り消されたためコンテナを起動しません");
      }

      const exitCode = await container.run((line) => {
        shipper.append(line);
      });
      await shipper.flush();
      await this.#finishJob(job, env, container, exitCode);
    } catch (err) {
      if (err instanceof ClaimRevokedError) {
        // 取り消されたジョブの成否を通知してはいけない（Step Functions側は既に
        // 別経路で処理を進めている）。claimも既にAWS側が外している。
        this.#log(`claimが取り消されたため実行を中止しました jobId=${jobId}`);
      } else {
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
      }
    } finally {
      running.finished.set();
      // 残りを送りきり、定期flushのタイマーも止める（ジョブごとに1本張るため）。
      await shipper.close();
      this.#running.delete(jobId);
    }
  }

  async #finishJob(
    job: JobRecord,
    env: Record<string, string>,
    container: Killable,
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
   * `running.finished` はジョブ側が終了時に立てるシグナルで、これが無いと最大
   * `CLAIM_CHECK_INTERVAL_SEC` ぶん監視ループが残り続ける。
   *
   * 取り消し済みでもまだ止められていない（`docker kill` が失敗した）間はループを
   * 続けて再試行する。「止めたことにする」より「止まるまで諦めない」方を選ぶ。
   *
   * **確認できない状態がどれだけ続いても録画は止めない**（`touchClaim` の失敗が続く
   * のはDynamoDB接続や認証情報の不調であり、取り消しの証拠ではない）。止めれば
   * そのジョブは丸ごとやり直しになる一方、止めずに得られる最悪の結果は「同じ動画を
   * 同じキーへ二重に書く」「statusが巻き戻る」程度で、金銭コストも増えない
   * （EC2と違い自宅の電気代はAWSの請求に現れない）。停止済みジョブが`done`へ戻って
   * 完了メールが飛ぶ、という本当に困る結果はジョブレコード側の拒否票
   * （`JobRecord.stopRequestedAt`）が止めるので、ここは完走に賭けてよい。
   * ただし**未確認のまま経過した時間はログに出す**（運用時に沈黙で見えなくなるのを
   * 避けるため。判断を変えるのではなく見えるようにするだけ）。
   */
  async watchClaim(jobId: string, running: ClaimWatchTarget): Promise<void> {
    let confirmedAtMs = Date.now();
    while (!running.finished.isSet) {
      await running.finished.wait(this.#claimCheckIntervalMs);
      if (running.finished.isSet) {
        return;
      }
      if (running.revoked.isSet) {
        // 取り消しは既に判明している。あとは確実に止めるだけ。
        await this.#enforceRevocation(jobId, running);
        continue;
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
        // 一時的なAPI障害では止めない（止めるほうが損失が大きい）。取り消しは
        // 「条件が崩れた」と分かったときにしか宣言しない。
        const unconfirmedSec = Math.round((Date.now() - confirmedAtMs) / 1000);
        this.#log(
          `claimの確認に失敗しました(継続 最後の確認から${unconfirmedSec}秒) ` +
            `jobId=${jobId}: ${String(err)}`,
        );
        continue;
      }
      if (!stillMine) {
        await this.#enforceRevocation(jobId, running);
        continue;
      }
      confirmedAtMs = Date.now();
    }
  }

  /**
   * オファーに再出現したジョブについて、claimが自分のものかを権威のある条件付き更新で
   * 確かめる（結果整合なGSIの残像と、本当の取り消しを見分けるため）。
   */
  async #recheckClaim(jobId: string, running: ClaimWatchTarget): Promise<void> {
    if (running.revoked.isSet) {
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
      this.#log(`オファー再出現時のclaim確認に失敗しました(継続) jobId=${jobId}: ${String(err)}`);
      return;
    }
    if (stillMine) {
      // 自分のclaim直後のGSI残像。何もしない（次の周回で消える）。
      return;
    }
    this.#log(`実行中のジョブが再オファーされていました jobId=${jobId}`);
    await this.#enforceRevocation(jobId, running);
  }

  /**
   * claimの取り消しを確定させ、コンテナを止める。**止められなかったことは黙って
   * 受け流さない**——`ContainerRun.kill()` が失敗した場合はコンテナが生き残って
   * 録画を続けているので、`killed` を立てずに監視ループの次の周回で再試行する
   * （立ててしまうと `#finishJob` が成否の通知もログも全部飛ばし、二重録画が
   * 誰にも気づかれないまま完走する）。
   */
  async #enforceRevocation(jobId: string, running: ClaimWatchTarget): Promise<void> {
    const firstTime = !running.revoked.isSet;
    running.revoked.set();
    const container = running.container;
    if (container === null) {
      // まだコンテナを起動していない。起動側が `revoked` を見て中止する。
      if (firstTime) {
        this.#log(`claimが取り消されました。コンテナは起動しません jobId=${jobId}`);
      }
      return;
    }
    if (container.killed) {
      return;
    }
    this.#log(`claimが取り消されました。コンテナを停止します jobId=${jobId}`);
    await this.#killContainer(jobId, container);
  }

  /** コンテナの停止を試みる（失敗しても例外にせず、呼び出し側の再試行に任せる）。 */
  async #killContainer(jobId: string, container: Killable): Promise<void> {
    try {
      await container.kill();
    } catch (err) {
      this.#log(
        `コンテナの停止に失敗しました(再試行します) jobId=${jobId}: ${String(err)}`,
      );
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
        Promise.allSettled([...this.#running.values()].map((job) => job.promise)),
        sleep(DRAIN_POLL_INTERVAL_MS),
      ]);
    }
    const remaining = this.activeJobs();
    if (remaining > 0) {
      this.#log(`待機時間を超過しました。${remaining}件のジョブを残して終了します`);
    }
  }
}
