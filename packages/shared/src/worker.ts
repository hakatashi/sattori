import type { GameId } from "./games.js";

/**
 * 録画ワーカーの種別と、自宅サーバーをワーカープールへ統合するための契約（Issue #49）。
 *
 * 録画ジョブは Step Functions の `Launch` ステート（`waitForTaskToken`）が
 * 「taskTokenを持つ主体が結果を返せば成立する」設計になっているため、EC2 Fleet で
 * 起動するワーカーと自宅サーバー上のワーカーは**まったく同じインターフェース**
 * （S3からリプレイ取得 → 録画 → S3へ結果アップロード → DynamoDB更新 → taskToken通知）
 * で扱える。実際に走るコンテナも同一の ECR イメージ（`worker/`）で、環境差分は
 * すべてコンテナに渡す環境変数（`apps/api/src/workerEnv.ts`）へ寄せる。
 *
 * 自宅サーバーは動的グローバルIP・NAT配下でAWS側から到達できない前提のため、
 * ジョブの割り当ては**Pull型**で行う:
 *
 * 1. 自宅の常駐デーモン（`home-worker/`）が `WorkersTable` へ定期的にハートビートを
 *    書き、自身の空き状況・対応タイトル・追加能力を自己申告する。
 * 2. `Launch` Lambda はハートビートを見て「今このジョブを任せられる自宅ワーカーが
 *    いるか」を判定し、いる場合だけジョブレコードへ**オファー**を書き込んで
 *    短時間（`GameRoutingPolicy.offerWindowSeconds`）だけ待つ。
 * 3. デーモンはオファー用のsparse GSIをポーリングし、条件付き更新でatomicにclaimする。
 * 4. 時間内にclaimされなければオファーを撤回し、従来どおり EC2 Fleet を起動する。
 *
 * ハートビートが無い・古い場合はオファー自体を行わないため、自宅サーバーが落ちて
 * いる平常時に録画開始が遅延することはない。
 */

/** ジョブを実際に実行しているワーカーの種別。 */
export const WORKER_KINDS = [
  "ec2", // EC2 Fleet(Spot)で起動した使い捨てインスタンス
  "home", // 開発者の自宅サーバー上の常駐デーモンがclaimしたジョブ(Issue #49)
] as const;

export type WorkerKind = (typeof WORKER_KINDS)[number];

/**
 * ワーカーが自己申告する「標準の録画以外にできること」。ジョブのルーティング条件
 * （`GameRoutingPolicy.requiredCapabilities`）として使う。
 *
 * - `slow-motion-recording`: 低速（例: 1/2倍速）で録画し、後処理で等速へ戻す
 *   （Issue #68）。録画に倍の実時間がかかるためEC2では割に合わないが、電気代しか
 *   かからない自宅ワーカーなら品質のために使える、という位置づけ。th20（東方錦上京、
 *   Issue #87）は描画負荷が高く、この能力を持つワーカーを優先したい。
 *   **能力の宣言はデーモン側の設定（`HOME_WORKER_CAPABILITIES`）で行う**ため、
 *   ここに定義があること自体は「実装済み」を意味しない。
 */
export const WORKER_CAPABILITIES = ["slow-motion-recording"] as const;

export type WorkerCapability = (typeof WORKER_CAPABILITIES)[number];

/**
 * `WorkersTable` の1アイテム（ワーカー1台ぶんのハートビート）。自宅デーモンが
 * `WORKER_HEARTBEAT_INTERVAL_SECONDS` ごとに丸ごと上書きする。
 *
 * EC2ワーカーはこのテーブルに現れない（使い捨てで、Launch Lambda が起動する側が
 * 存在を把握しているため）。あくまで「AWS側から到達できない常駐ワーカーが自分の
 * 生存と空き状況を知らせる」ための board である。
 */
export interface WorkerHeartbeat {
  /** ワーカーの識別子（デーモンの `HOME_WORKER_ID`、例 `home-1`）。 */
  workerId: string;
  /** 現状 `home` のみ。将来別種の常駐ワーカーを足す場合の区別用。 */
  kind: Extract<WorkerKind, "home">;
  /** 最後にハートビートを書いた時刻（ISO 8601）。鮮度判定に使う。 */
  lastHeartbeatAt: string;
  /**
   * 新規ジョブを受け付ける意思があるか。CPU使用率の余裕・ドレイン中（終了処理中）
   * かどうかをデーモンが自己判定して申告する。**実行中ジョブの継続とは独立**で、
   * false でも既に走っているジョブは最後まで完走させる（Issue #49 の論点4）。
   */
  accepting: boolean;
  /** デーモンが現在実行中のジョブ数。 */
  activeJobs: number;
  /** 同時実行の上限（`HOME_WORKER_MAX_CONCURRENCY`）。 */
  maxConcurrency: number;
  /**
   * このワーカーがタイトル資産を用意できるタイトル。実際のダウンロード・展開は
   * コンテナ内（`worker/title_assets.py`）が行うため通常は録画対応タイトル全部に
   * なるが、自宅側のディスク都合などで絞れるようにしておく。
   */
  supportedGames: GameId[];
  /** 追加能力（`WorkerCapability`）。宣言していない能力を要求するジョブは回ってこない。 */
  capabilities: WorkerCapability[];
  /** DynamoDB TTL（epoch秒）。デーモンが止まったレコードを自動で掃除する。 */
  ttl: number;
}

/**
 * デーモンがハートビートを書き直す間隔（秒）。
 * `WORKER_HEARTBEAT_FRESH_SECONDS` の余裕をもって下回るように選ぶ。
 */
export const WORKER_HEARTBEAT_INTERVAL_SECONDS = 15;

/**
 * ハートビートを「新鮮」＝ワーカーが生きているとみなす上限（秒）。これを過ぎた
 * ハートビートはオファー判定で無視する。
 *
 * 短くしすぎると一時的なネットワーク瞬断でオファーが止まり、長くしすぎると
 * 落ちた自宅ワーカーへオファーして`offerWindowSeconds`ぶん録画開始が遅れる。
 * ハートビート間隔の3回ぶんを許容する設定にしてある。
 */
export const WORKER_HEARTBEAT_FRESH_SECONDS = WORKER_HEARTBEAT_INTERVAL_SECONDS * 3;

/** ハートビートのDynamoDB TTL（秒）。鮮度判定より十分長くし、履歴として少し残す。 */
export const WORKER_HEARTBEAT_TTL_SECONDS = 15 * 60;

/**
 * ジョブレコードに書かれるオファーの状態。sparse GSI（`HomeWorkerOfferIndex`）の
 * パーティションキーとして使うため、**オファー中のジョブだけがこの属性を持つ**
 * （撤回・claim時は属性ごと削除する）。値が1種類しかないのは、インデックスを
 * 「今オファー中のジョブ一覧」そのものにするため。
 */
export const HOME_WORKER_OFFER_OPEN = "open";
export type HomeWorkerOfferState = typeof HOME_WORKER_OFFER_OPEN;

/**
 * オファー用sparse GSIの名前。CDK（`infra/lib/sattori-stack.ts`）がインデックスを作り、
 * `Launch` Lambda（オファーを書く側）と自宅デーモン（`home-worker/`、Query する側）が
 * 同じ名前を参照する。3者に同じ文字列を書き写すと片方だけ直したときに気づけないため、
 * 共有パッケージの定数を唯一の出典にしている。
 */
export const HOME_WORKER_OFFER_INDEX = "HomeWorkerOfferIndex";

/**
 * `Launch` Lambda のタイムアウト（秒）。CDK（`infra/lib/sattori-stack.ts`）が
 * この値で関数を作る。
 *
 * `Launch` はオファーがclaimされるのを**同期的に待つ**（`waitForHomeWorkerClaim`）
 * ため、`GameRoutingPolicy.offerWindowSeconds` を伸ばすとこのタイムアウトに
 * ぶつかる。待機の直後にはEC2 Fleetの起動（`CreateLaunchTemplateVersion` →
 * `CreateFleet` → `DescribeSpotPriceHistory` → ジョブレコード更新）が控えており、
 * タイムアウトで途中死すると **オファーは撤回済みなのにEC2も起動していない**
 * 状態で15分のハートビートタイムアウトを待つことになる。
 * 両者の関係は `apps/api/src/workerRouting.ts` の `MAX_OFFER_WINDOW_SECONDS`
 * で明文化し、テストで守っている。
 */
export const LAUNCH_LAMBDA_TIMEOUT_SECONDS = 60;

/**
 * ワーカーコンテナへ渡す環境変数一式（`apps/api/src/workerEnv.ts` が組み立てる）。
 * EC2では UserData の `docker run -e` に展開され、自宅ワーカーではオファーに
 * 添えてジョブレコードへ書かれ、デーモンがそのまま `docker run` へ渡す。
 *
 * **ワーカー側に「EC2か自宅か」を判定させない**ための構造でもある。低速録画
 * （Issue #68）のような自宅限定の挙動も、ワーカーの分岐ではなく「起動側が渡す
 * 環境変数の違い」として表現する。
 */
export type WorkerEnvironment = Record<string, string>;

/**
 * 「`TASK_TOKEN` を伏せた」ことを表す型だけのブランド。実体には存在しないプロパティで、
 * `unique symbol` なので他の型と偶然一致することもない。
 */
export declare const redactedWorkerEnvironment: unique symbol;

/**
 * `TASK_TOKEN` を伏せた `WorkerEnvironment`。**サービスの外へ出す経路
 * （管理APIのレスポンス・ログ）ではこちらの型だけを使う**。
 *
 * ブランドを交差させているのは、`WorkerEnvironment` をうっかりそのまま代入したときに
 * 型エラーにするため。`WorkerEnvironment` は `Record<string, string>` なので、
 * `Omit<..., "TASK_TOKEN">` や `TASK_TOKEN?: undefined` では**何も防げない**
 * （インデックスシグネチャが optional なプロパティの互換性判定に使われないため、
 * どちらも素通りする）。値を落とす実処理とこの型への変換は
 * `apps/api/src/workerEnv.ts` の `redactWorkerEnv()` の1箇所だけで行う。
 */
export type RedactedWorkerEnvironment = WorkerEnvironment & {
  readonly [redactedWorkerEnvironment]: true;
};

/**
 * ハートビートが新鮮か（＝ワーカーが生きているとみなせるか）。
 *
 * 未来方向のずれも同じ幅までしか許容しない。自宅マシンの時計が大きく進んでいると
 * 「止まったデーモンのハートビートがいつまでも新鮮に見える」＝オファーが吸い込まれ
 * 続ける事故になるため、明らかな時計異常は不健全側（オファーしない）に倒す。
 */
export function isHeartbeatFresh(heartbeat: WorkerHeartbeat, now: Date): boolean {
  const lastSeen = Date.parse(heartbeat.lastHeartbeatAt);
  if (Number.isNaN(lastSeen)) {
    return false;
  }
  const ageSeconds = (now.getTime() - lastSeen) / 1000;
  return Math.abs(ageSeconds) <= WORKER_HEARTBEAT_FRESH_SECONDS;
}
