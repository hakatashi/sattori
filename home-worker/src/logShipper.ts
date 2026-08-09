/**
 * ワーカーコンテナの標準出力を CloudWatch Logs へ転送する（Issue #49）。
 *
 * EC2ワーカーでは docker の `awslogs` ログドライバがこれを担うが、そのドライバは
 * **dockerデーモン自身の**AWS認証情報を使う。自宅マシンのdockerデーモンに
 * 認証情報を持たせるのは設定が煩雑なうえ、デーモン全体に権限が漏れるため避けたい。
 * 代わりにこのプロセスがコンテナの出力を読み、EC2ワーカーと**同じロググループ・
 * 同じストリーム名（=jobId）**へ書く。こうすることで管理画面のログ表示（Issue #58）は
 * ワーカーの種別を意識せずに済む。
 *
 * `PutLogEvents` はシーケンストークン不要（2023年以降）なので、素朴にバッファして
 * 投げるだけでよい。ログ転送の失敗で録画を止めることはしない（診断情報の欠落より
 * 録画結果を失うほうが損失が大きい）。
 */
import {
  CreateLogStreamCommand,
  PutLogEventsCommand,
  ResourceAlreadyExistsException,
} from "@aws-sdk/client-cloudwatch-logs";
import type { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";

/** 1回のPutLogEventsに詰める最大件数（APIの上限は10000件/1MB）。 */
export const MAX_BATCH_SIZE = 500;

/** バッファをflushするまでの最大待ち時間（ミリ秒）。 */
export const FLUSH_INTERVAL_MS = 5000;

export interface LogShipperOptions {
  log?: (message: string) => void;
  /** テスト用の時計（epochミリ秒）。 */
  now?: () => number;
}

interface LogEvent {
  timestamp: number;
  message: string;
}

export class CloudWatchLogShipper {
  readonly #client: CloudWatchLogsClient;
  readonly #logGroup: string;
  readonly #logStream: string;
  readonly #log: (message: string) => void;
  readonly #now: () => number;
  #buffer: LogEvent[] = [];
  #lastFlush: number;
  #streamReady = false;
  #disabled = false;
  /**
   * flush の直列化。`append()` は同期的に呼ばれる（コンテナ出力の1行ごと）ため、
   * 自動flushは待たずに走らせる。順序を守るために前のflushへ繋いでいく。
   */
  #chain: Promise<void> = Promise.resolve();

  constructor(
    client: CloudWatchLogsClient,
    logGroup: string,
    logStream: string,
    options: LogShipperOptions = {},
  ) {
    this.#client = client;
    this.#logGroup = logGroup;
    this.#logStream = logStream;
    this.#log = options.log ?? ((message): void => console.log(message));
    this.#now = options.now ?? ((): number => Date.now());
    this.#lastFlush = this.#now();
  }

  append(message: string): void {
    if (this.#disabled) {
      return;
    }
    this.#buffer.push({ timestamp: Math.floor(this.#now()), message });
    if (
      this.#buffer.length >= MAX_BATCH_SIZE ||
      this.#now() - this.#lastFlush >= FLUSH_INTERVAL_MS
    ) {
      void this.flush();
    }
  }

  async flush(): Promise<void> {
    this.#chain = this.#chain.then(async () => {
      await this.#flushOnce();
    });
    await this.#chain;
  }

  async #flushOnce(): Promise<void> {
    if (this.#disabled || this.#buffer.length === 0) {
      this.#lastFlush = this.#now();
      return;
    }
    const events = this.#buffer;
    this.#buffer = [];
    try {
      await this.#ensureStream();
      await this.#client.send(
        new PutLogEventsCommand({
          logGroupName: this.#logGroup,
          logStreamName: this.#logStream,
          logEvents: events,
        }),
      );
    } catch (err) {
      // ログ転送の失敗で録画は止めない。以降は転送そのものを諦める
      // （毎行失敗し続けてデーモンのログを埋めるほうが害が大きい）。
      this.#log(`[logShipper] CloudWatch Logsへの転送に失敗(以降は転送を諦めます): ${String(err)}`);
      this.#disabled = true;
    } finally {
      this.#lastFlush = this.#now();
    }
  }

  async #ensureStream(): Promise<void> {
    if (this.#streamReady) {
      return;
    }
    try {
      await this.#client.send(
        new CreateLogStreamCommand({
          logGroupName: this.#logGroup,
          logStreamName: this.#logStream,
        }),
      );
    } catch (err) {
      // 既存ストリームの再作成は正常系（Step Functionsのリトライで同じjobIdの
      // ストリームが既にある）。
      if (!(err instanceof ResourceAlreadyExistsException)) {
        throw err;
      }
    }
    this.#streamReady = true;
  }
}
