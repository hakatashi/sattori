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
 * 録画結果を失うほうが損失が大きい）。ただし**失敗しても転送自体を諦めない**
 * ——1回の失敗で以降を捨てると、まさに出力が多い（＝何かが起きている）回に限って
 * ログが尻切れになる。うるさいのは失敗ログの方なので、抑制するのはそちらにする。
 *
 * バッチは件数とバイト数の両方で切る。`PutLogEvents` には 1MiB/リクエストの
 * ハードリミットがあり、超えたバッチは**再試行しても通らない** 400
 * （`InvalidParameterException`）で丸ごと捨てられるため、件数だけでは守れない。
 */
import {
  CreateLogStreamCommand,
  PutLogEventsCommand,
  ResourceAlreadyExistsException,
} from "@aws-sdk/client-cloudwatch-logs";
import type { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";

/** 1回のPutLogEventsに詰める最大件数（APIの上限は10000件）。 */
export const MAX_BATCH_SIZE = 500;

/**
 * 1回のPutLogEventsに詰める最大バイト数。APIの上限は 1,048,576 バイトで、
 * イベントごとに26バイトのオーバーヘッドが加算される。上限ぎりぎりを狙う意味は
 * 無いので、多少の余裕を持たせてある。
 */
export const MAX_BATCH_BYTES = 900_000;

/** 1イベントの最大バイト数（APIの上限256KiBに対して余裕を持たせた値）。 */
export const MAX_EVENT_BYTES = 200_000;

/** イベント1件あたりのAPI側オーバーヘッド（バイト）。 */
const EVENT_OVERHEAD_BYTES = 26;

/** バッファをflushするまでの最大待ち時間（ミリ秒）。 */
export const FLUSH_INTERVAL_MS = 5000;

/**
 * 転送に失敗し続けたときにログを出す間隔（この回数ごとに1行）。うるさいのは
 * 失敗ログであって転送そのものではないので、抑制するのはログだけにする。
 */
export const FAILURE_LOG_EVERY = 20;

export interface LogShipperOptions {
  log?: (message: string) => void;
  /** テスト用の時計（epochミリ秒）。 */
  now?: () => number;
  /**
   * 定期flushのタイマーを張るか（既定 true）。テストでは実タイマーを持ち込まない
   * ために false にできる。
   */
  autoFlush?: boolean;
}

interface LogEvent {
  timestamp: number;
  message: string;
}

function eventBytes(event: LogEvent): number {
  return Buffer.byteLength(event.message, "utf8") + EVENT_OVERHEAD_BYTES;
}

/** 単体で上限を超える行を、バイト境界を壊さずに切り詰める。 */
function truncate(message: string): string {
  if (Buffer.byteLength(message, "utf8") <= MAX_EVENT_BYTES) {
    return message;
  }
  const suffix = "…(切り詰め)";
  const limit = MAX_EVENT_BYTES - Buffer.byteLength(suffix, "utf8");
  return `${Buffer.from(message, "utf8").subarray(0, limit).toString("utf8")}${suffix}`;
}

export class CloudWatchLogShipper {
  readonly #client: CloudWatchLogsClient;
  readonly #logGroup: string;
  readonly #logStream: string;
  readonly #log: (message: string) => void;
  readonly #now: () => number;
  readonly #autoFlush: boolean;
  #buffer: LogEvent[] = [];
  #bufferBytes = 0;
  #lastFlush: number;
  #streamReady = false;
  #timer: NodeJS.Timeout | undefined;
  /** 連続した転送失敗の回数（成功したら0に戻す）。ログの抑制に使う。 */
  #failures = 0;
  /** 失敗して捨てた行数の累計（最後にまとめて報告する）。 */
  #dropped = 0;
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
    this.#autoFlush = options.autoFlush ?? true;
    this.#lastFlush = this.#now();
  }

  append(message: string): void {
    const event: LogEvent = { timestamp: Math.floor(this.#now()), message: truncate(message) };
    const size = eventBytes(event);
    if (this.#buffer.length >= MAX_BATCH_SIZE || this.#bufferBytes + size > MAX_BATCH_BYTES) {
      // この行を足すと上限を超える。**足す前に**現在のバッファを切り出す。
      this.#enqueue();
    }
    this.#buffer.push(event);
    this.#bufferBytes += size;
    this.#ensureTimer();
    if (this.#now() - this.#lastFlush >= FLUSH_INTERVAL_MS) {
      this.#enqueue();
    }
  }

  /** バッファを送信キューへ移し、キューが捌けるまで待つ。 */
  async flush(): Promise<void> {
    this.#enqueue();
    await this.#chain;
  }

  /**
   * ジョブ終了時の後始末（残りを送ってタイマーを止める）。呼ばないと定期flushの
   * タイマーがジョブの数だけ残る。
   */
  async close(): Promise<void> {
    await this.flush();
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    if (this.#dropped > 0) {
      this.#log(
        `[logShipper] CloudWatch Logsへ転送できなかった行が${this.#dropped}行あります` +
          `(${this.#failures}回連続で失敗中)`,
      );
    }
  }

  /**
   * バッファを**同期的に**切り出して送信キューへ積む。切り出しを非同期にすると、
   * 待っている間に足された行が同じバッチに混ざり、バイト上限の計算が崩れる。
   */
  #enqueue(): void {
    this.#lastFlush = this.#now();
    if (this.#buffer.length === 0) {
      return;
    }
    const events = this.#buffer;
    this.#buffer = [];
    this.#bufferBytes = 0;
    this.#chain = this.#chain.then(async () => {
      await this.#send(events);
    });
  }

  /**
   * 定期flushのタイマーを（最初の行が来たときに）張る。`append()` の中だけで
   * 経過時間を見ていると、出力が止まったコンテナのバッファが次の行まで送られない。
   */
  #ensureTimer(): void {
    if (!this.#autoFlush || this.#timer !== undefined) {
      return;
    }
    this.#timer = setInterval(() => {
      this.#enqueue();
    }, FLUSH_INTERVAL_MS);
    // 常駐プロセスを引き止める理由が無いのでイベントループには数えさせない
    // （ジョブの実行そのものがプロセスを生かしている）。
    this.#timer.unref();
  }

  async #send(events: LogEvent[]): Promise<void> {
    try {
      await this.#ensureStream();
      await this.#client.send(
        new PutLogEventsCommand({
          logGroupName: this.#logGroup,
          logStreamName: this.#logStream,
          logEvents: events,
        }),
      );
      if (this.#failures > 0) {
        this.#log(`[logShipper] CloudWatch Logsへの転送が復旧しました(失敗${this.#failures}回)`);
        this.#failures = 0;
      }
    } catch (err) {
      // ログ転送の失敗で録画は止めない。転送も諦めない（次のバッチは通るかも
      // しれない）。うるさくならないよう、ログだけ間引く。
      this.#dropped += events.length;
      this.#failures += 1;
      if (this.#failures === 1 || this.#failures % FAILURE_LOG_EVERY === 0) {
        this.#log(
          `[logShipper] CloudWatch Logsへの転送に失敗(${this.#failures}回目、` +
            `${events.length}行を破棄): ${String(err)}`,
        );
      }
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
