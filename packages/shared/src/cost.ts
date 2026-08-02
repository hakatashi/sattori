import type { GameId } from "./games.js";
import type { JobRecord } from "./job.js";
import { OUTPUT_RETENTION_DAYS } from "./job.js";

/**
 * 録画ジョブ1件あたりのコスト推定（Issue #60）。管理画面のジョブ詳細と
 * コスト集計ページ（`GET /admin/costs`）の両方がこのモジュールを共有する
 * （フロント側で表示だけ再計算して数字が食い違う、という事故を避けるため）。
 *
 * **これは請求額ではなく推定値**である。AWSの実際の請求はアカウント単位・
 * 時間按分・無料枠適用後の金額で確定するため、ジョブ単位に分解した時点で
 * 必ず誤差が乗る。用途は「どのジョブが異常に高いか」「月次でいくら使っているか」
 * を運用者が把握することであり、会計用途ではない。
 *
 * 単価と稼働前提の出典は `docs/aws-region-cost-analysis.md`（2026-07-27時点、
 * us-east-1）。2026-08のeu-south-2移設に伴い、単価定数はeu-south-2の値へ入れ替えた
 * （AWS Price List APIおよびSpot価格履歴で2026-08-03に再確認）。リージョンを
 * 再度移す場合はここの定数も入れ替えること。
 */

/** 単価の対象リージョン。表示に添えて「どこの単価か」を明示するために持つ。 */
export const COST_PRICING_REGION = "eu-south-2";

/** 単価表の調査時点（`docs/aws-region-cost-analysis.md`）。 */
export const COST_PRICING_AS_OF = "2026-08-03";

/**
 * ストレージ課金の1GBのバイト数。AWSのストレージ系（S3・EBS）の "GB" は
 * 2^30 バイト（＝GiB）を指すため、10^9 ではなくこちらを使う。
 */
export const BYTES_PER_GB = 1024 ** 3;

/**
 * 月額単価を時間按分するときの「1ヶ月」の時間数。AWSがEBS等の按分に使う
 * 慣用値（730時間 = 365日 / 12ヶ月 × 24時間）。
 */
export const HOURS_PER_MONTH = 730;

/** S3 Standard のストレージ単価（USD/GB-月、eu-south-2、〜450TB帯）。us-east-1と同額。 */
export const S3_STANDARD_USD_PER_GB_MONTH = 0.023;

/** EBS gp3 のストレージ単価（USD/GB-月、eu-south-2）。us-east-1の0.08より僅かに高い。 */
export const EBS_GP3_USD_PER_GB_MONTH = 0.088;

/**
 * ワーカーのルートEBSボリュームサイズ（GiB）。ECS最適化AL2023 AMIの既定値で、
 * Launch Template（`infra/lib/sattori-stack.ts`）でも上書きしていない。
 */
export const WORKER_ROOT_VOLUME_GIB = 30;

/** パブリックIPv4アドレスの単価（USD/時）。全リージョン一律。 */
export const PUBLIC_IPV4_USD_PER_HOUR = 0.005;

/**
 * Lambda・Step Functions・DynamoDB・SES・CloudWatch Logs をまとめた
 * 1ジョブあたりの概算（USD）。個別に計上しても合計で月$2程度（月1000録画）に
 * しかならず、ジョブ単位に正確に分解する労力に見合わないため定数で置く
 * （`docs/aws-region-cost-analysis.md` §4.2・§5）。
 */
export const MISC_USD_PER_JOB = 2.0 / 1000;

/**
 * CloudFront の常時無料枠（GB/月）。12ヶ月限定ではなく Always Free。
 * 現状の月1000録画規模ではこの枠にほぼ収まっている（＝配信コストは$0）が、
 * 720p版の平均サイズが約1GiBあるため**枠を使い切る寸前**という認識が重要
 * （`docs/aws-region-cost-analysis.md` §6）。集計APIはこの枠を超えた分だけを
 * 課金対象として計上する。
 */
export const CLOUDFRONT_FREE_TIER_GB_PER_MONTH = 1000;

/**
 * CloudFront の無料枠超過分の単価（USD/GB）。北米・欧州エッジの単価を採用する。
 * 実際の課金は視聴者の地理で決まり、日本のエッジなら $0.114/GB とこれより
 * 34%高い（＝ここでの推定は日本のユーザーが多いほど過小になる）。
 */
export const CLOUDFRONT_USD_PER_GB = 0.085;

/**
 * `spotPricePerHour` が記録されていないジョブ（このフィールドの追加より前に
 * 実行された旧ジョブ、または`DescribeSpotPriceHistory`が失敗したジョブ）に使う
 * フォールバック単価（USD/時、eu-south-2）。
 *
 * インスタンスタイプ個別ではなくサイズ帯（`.xlarge` / `.2xlarge`）で持つ:
 * 候補タイプは`price-capacity-optimized`で選ばれるためどれが確保されるか事前に
 * 決まらず、同帯なら価格差も小さいので、帯の代表値で十分という判断。
 *
 * 暫定値: 2026-08-03時点の直近3日間のSpot価格履歴の単純平均から算出。
 * us-east-1時代（`docs/aws-region-cost-analysis.md` §2）と同様の30日間・
 * 時間重み付き平均（TWA）での再計測がまだのため、実際の値とは数%ずれうる。
 * 次にこの定数を見直す際はTWAで再計測すること。
 */
export const FALLBACK_SPOT_PRICE_USD_PER_HOUR = {
  xlarge: 0.045,
  "2xlarge": 0.092,
} as const;

/**
 * `launchedAt` が記録されていないジョブ（このフィールドの追加より前に実行された
 * 旧ジョブ）に使う、課金対象時間のフォールバック（時間）。本番実績の
 * フルラン中心値0.60時間 × リトライ/Spot中断の割増1.10
 * （`docs/aws-region-cost-analysis.md` §1.3）。
 */
export const FALLBACK_BILLED_HOURS = 0.6 * 1.1;

/**
 * 円換算に使う為替レート（JPY/USD）。管理画面の通貨切り替え用。
 *
 * AWSの請求はUSD建てで、実際の請求額は「AWSがその月に適用したレート」で円に
 * 換算される（さらにカード会社の手数料が乗る）ため、ここで固定レートを使う
 * 時点で数%の誤差は避けられない。コスト推定そのものが桁を掴むための概算である
 * 以上、日次でレートを取得する仕組み（外部API・Lambda・キャッシュ）を足す価値は
 * 無いと判断して**定数で持つ**。ズレが気になったらこの値を書き換えるだけでよい。
 */
export const USD_TO_JPY_RATE = 157;

/** `USD_TO_JPY_RATE` を最後に確認した日付。UIに添えて鮮度を明示する。 */
export const USD_TO_JPY_RATE_AS_OF = "2026-08-03";

/** USDを円に換算する（`USD_TO_JPY_RATE`による概算）。 */
export function usdToJpy(usd: number): number {
  return usd * USD_TO_JPY_RATE;
}

/** コスト推定に必要な `JobRecord` のフィールドだけを抜き出した入力型。 */
export type JobCostInput = Pick<
  JobRecord,
  | "status"
  | "game"
  | "createdAt"
  | "updatedAt"
  | "launchedAt"
  | "doneAt"
  | "instanceId"
  | "instanceType"
  | "spotPricePerHour"
  | "outputPath"
  | "outputPath720p"
  | "outputBytes"
  | "outputBytes720p"
>;

/** コストの内訳（USD）。加算できるよう、集計側でも同じ形を使う。 */
export interface CostBreakdown {
  /** EC2 Spot インスタンス。全体の7割超を占める支配的な項目。 */
  ec2Spot: number;
  /** ルートEBSボリューム（gp3 30GiB）の時間按分。 */
  ebs: number;
  /** パブリックIPv4アドレスの時間課金。 */
  publicIpv4: number;
  /** 出力動画のS3保管料（ライフサイクルルールの保持期間ぶん）。 */
  s3Storage: number;
  /** Lambda/Step Functions/DynamoDB/SES/CloudWatch Logs の概算。 */
  misc: number;
}

/** 空の内訳（集計の初期値）。 */
export function emptyCostBreakdown(): CostBreakdown {
  return { ec2Spot: 0, ebs: 0, publicIpv4: 0, s3Storage: 0, misc: 0 };
}

/** 内訳を足し合わせる（集計用。`total`は`sumCostBreakdown`で別途求める）。 */
export function addCostBreakdown(a: CostBreakdown, b: CostBreakdown): CostBreakdown {
  return {
    ec2Spot: a.ec2Spot + b.ec2Spot,
    ebs: a.ebs + b.ebs,
    publicIpv4: a.publicIpv4 + b.publicIpv4,
    s3Storage: a.s3Storage + b.s3Storage,
    misc: a.misc + b.misc,
  };
}

/** 内訳の合計（USD）。 */
export function sumCostBreakdown(breakdown: CostBreakdown): number {
  return (
    breakdown.ec2Spot +
    breakdown.ebs +
    breakdown.publicIpv4 +
    breakdown.s3Storage +
    breakdown.misc
  );
}

/** 課金対象時間をどう決めたか。UIで推定の確からしさを注記するために返す。 */
export type BilledDurationSource =
  /** `launchedAt` と終了時刻の実測（最も確か）。 */
  | "measured"
  /** まだ実行中で、終了時刻に「現在時刻」を使っている（値は増え続ける）。 */
  | "running"
  /** `launchedAt` が無い旧ジョブ。`FALLBACK_BILLED_HOURS` で代用している。 */
  | "assumed"
  /** EC2が一度も起動していない（pendingのまま期限切れ等）。EC2系のコストは0。 */
  | "not-launched";

/** Spot単価をどう決めたか。 */
export type SpotPriceSource =
  /** 起動時に`DescribeSpotPriceHistory`で記録した実測値。 */
  | "recorded"
  /** `instanceType`のサイズ帯から引いたフォールバック単価。 */
  | "fallback-instance-type"
  /** インスタンスタイプ不明。ゲーム（th11か否か）からサイズ帯を推定した。 */
  | "fallback-game";

/** 1ジョブぶんのコスト推定結果。 */
export interface JobCostEstimate {
  breakdown: CostBreakdown;
  /** `breakdown`の合計（USD）。CloudFrontの配信料は**含まない**（後述）。 */
  totalUsd: number;
  /** 課金対象と見なしたEC2稼働時間（秒）。 */
  billedSeconds: number;
  billedDurationSource: BilledDurationSource;
  /** 計算に使ったSpot単価（USD/時）。 */
  spotPricePerHour: number;
  spotPriceSource: SpotPriceSource;
  /**
   * このジョブが生む CloudFront 配信量の見積り（バイト）。「720p版が1回
   * ダウンロードされる」という前提（`docs/aws-region-cost-analysis.md` §6 と同じ
   * モデル。ユーザーの大半は720p版だけを落とすと仮定）で、720p版が無ければ
   * 元解像度版で代用する。
   *
   * 配信料そのものを`breakdown`に入れないのは、無料枠(1TB/月)が**アカウント
   * 単位・月単位**で効くためジョブ単位では原理的に配分できないから。集計API
   * （`GET /admin/costs`）が月ごとに超過分を計上する。
   */
  deliveryBytes: number;
  /** 出力動画のS3保管対象バイト数（元解像度版＋720p版）。 */
  storedBytes: number;
  /**
   * `outputBytes`/`outputBytes720p`が記録されておらず、動画サイズが不明のまま
   * 0として扱われたか（このフィールド追加より前の旧ジョブ）。true のとき
   * `s3Storage`と`deliveryBytes`は過小になる。
   */
  outputSizeUnknown: boolean;
}

/** インスタンスタイプ（例 `c7i.2xlarge`）からサイズ帯を取り出す。 */
function sizeClassOf(instanceType: string): keyof typeof FALLBACK_SPOT_PRICE_USD_PER_HOUR {
  return instanceType.endsWith(".2xlarge") ? "2xlarge" : "xlarge";
}

/**
 * ゲームからサイズ帯を推定する。th11だけ`.2xlarge`帯の候補リストを使う
 * （`apps/api/src/ec2.ts`の`TH11_CANDIDATE_INSTANCE_TYPES`、touhou-recorder
 * reports/40）。
 */
function sizeClassOfGame(game: GameId): keyof typeof FALLBACK_SPOT_PRICE_USD_PER_HOUR {
  return game === "th11" ? "2xlarge" : "xlarge";
}

function resolveSpotPrice(job: JobCostInput): {
  price: number;
  source: SpotPriceSource;
} {
  if (job.spotPricePerHour !== null && job.spotPricePerHour > 0) {
    return { price: job.spotPricePerHour, source: "recorded" };
  }
  if (job.instanceType !== null) {
    return {
      price: FALLBACK_SPOT_PRICE_USD_PER_HOUR[sizeClassOf(job.instanceType)],
      source: "fallback-instance-type",
    };
  }
  return {
    price: FALLBACK_SPOT_PRICE_USD_PER_HOUR[sizeClassOfGame(job.game)],
    source: "fallback-game",
  };
}

/** パース不能なら null（旧レコードや手で壊されたレコードで落ちないように）。 */
function parseTime(iso: string | null): number | null {
  if (iso === null) {
    return null;
  }
  const value = Date.parse(iso);
  return Number.isNaN(value) ? null : value;
}

/**
 * EC2が一度でも起動したか。`launchedAt`はこのフィールド追加より後のジョブしか
 * 持たないため、旧ジョブでも「起動した痕跡」（インスタンスID・出力・録画以降の
 * status）から判定できるようにする。ここで false なら EC2/EBS/IPv4 のコストは0。
 */
function hasEverLaunched(job: JobCostInput): boolean {
  return (
    job.launchedAt !== null ||
    job.instanceId !== null ||
    job.outputPath !== null ||
    job.outputPath720p !== null ||
    job.status === "launching" ||
    job.status === "recording" ||
    job.status === "converting" ||
    job.status === "done"
  );
}

/**
 * 課金対象のEC2稼働時間（秒）を求める。
 *
 * 起点は`launchedAt`（＝最初にEC2を起動した時刻）。終点は完了ジョブなら`doneAt`、
 * 失敗ジョブなら`updatedAt`（最後のハートビート＝概ね失敗確定時刻）、実行中なら
 * 現在時刻。
 *
 * **リトライを跨いだ実時間をそのまま課金時間と見なす**。厳密には試行と試行の
 * 間（インフラ側の`WaitBeforeCheck`の3分など）はEC2が動いておらず、そのぶん
 * 過大評価になる。試行ごとの正確な稼働区間を持つにはLaunch/Terminateの時刻を
 * 全試行ぶん記録する必要があり、月1000ジョブ規模の運用把握という目的に対して
 * 割に合わないため、**過大側に倒れる単純なモデル**を選んでいる。
 */
function resolveBilledSeconds(
  job: JobCostInput,
  now: number,
): { seconds: number; source: BilledDurationSource } {
  if (!hasEverLaunched(job)) {
    return { seconds: 0, source: "not-launched" };
  }

  const start = parseTime(job.launchedAt);
  if (start === null) {
    return { seconds: FALLBACK_BILLED_HOURS * 3600, source: "assumed" };
  }

  const isTerminal = job.status === "done" || job.status === "failed";
  const end = isTerminal ? (parseTime(job.doneAt) ?? parseTime(job.updatedAt) ?? now) : now;
  // 時計のずれや手で書き換えたレコードで負値にならないようにする。
  const seconds = Math.max(0, (end - start) / 1000);
  return { seconds, source: isTerminal ? "measured" : "running" };
}

/**
 * ジョブ1件のコストを推定する。純関数（`now`を明示的に受け取る）にしてあるのは、
 * 実行中ジョブの推定値が呼び出しごとに揺れるのをテストで固定できるようにするため。
 */
export function estimateJobCost(job: JobCostInput, now: Date = new Date()): JobCostEstimate {
  const { seconds: billedSeconds, source: billedDurationSource } = resolveBilledSeconds(
    job,
    now.getTime(),
  );
  const billedHours = billedSeconds / 3600;
  const { price: spotPricePerHour, source: spotPriceSource } = resolveSpotPrice(job);

  const storedBytes = (job.outputBytes ?? 0) + (job.outputBytes720p ?? 0);
  // 出力パスはあるのにサイズが無い＝旧ジョブ（ワーカーがサイズを記録する前に完了した）。
  const outputSizeUnknown =
    (job.outputPath !== null && job.outputBytes === null) ||
    (job.outputPath720p !== null && job.outputBytes720p === null);

  const breakdown: CostBreakdown = {
    ec2Spot: spotPricePerHour * billedHours,
    ebs: WORKER_ROOT_VOLUME_GIB * EBS_GP3_USD_PER_GB_MONTH * (billedHours / HOURS_PER_MONTH),
    publicIpv4: PUBLIC_IPV4_USD_PER_HOUR * billedHours,
    // 出力はライフサイクルルールで`OUTPUT_RETENTION_DAYS`日後に消えるため、
    // 保管料はその期間ぶんだけを計上する（それ以上は課金されない）。
    s3Storage:
      (storedBytes / BYTES_PER_GB) *
      S3_STANDARD_USD_PER_GB_MONTH *
      ((OUTPUT_RETENTION_DAYS * 24) / HOURS_PER_MONTH),
    misc: MISC_USD_PER_JOB,
  };

  return {
    breakdown,
    totalUsd: sumCostBreakdown(breakdown),
    billedSeconds,
    billedDurationSource,
    spotPricePerHour,
    spotPriceSource,
    deliveryBytes: job.outputBytes720p ?? job.outputBytes ?? 0,
    storedBytes,
    outputSizeUnknown,
  };
}

/** コスト集計の粒度（`GET /admin/costs?granularity=`）。 */
export const COST_GRANULARITIES = ["daily", "weekly", "monthly"] as const;
export type CostGranularity = (typeof COST_GRANULARITIES)[number];

/**
 * 集計のバケットキーを求める。**すべてUTC基準**。AWSの請求自体がUTC日付で
 * 区切られるうえ、`JobRecord`の時刻もすべてUTCのISO 8601なので、ローカル
 * タイムゾーンを持ち込まないほうが請求書と突き合わせやすい。
 *
 * - daily: `YYYY-MM-DD`
 * - weekly: その週の月曜日の `YYYY-MM-DD`（ISO 8601の週の始まり）
 * - monthly: `YYYY-MM`
 */
export function costBucketKey(date: Date, granularity: CostGranularity): string {
  const iso = date.toISOString();
  if (granularity === "monthly") {
    return iso.slice(0, 7);
  }
  if (granularity === "daily") {
    return iso.slice(0, 10);
  }
  // getUTCDay(): 0=日曜。月曜始まりにするため日曜を7として扱う。
  const dayOfWeek = date.getUTCDay() === 0 ? 7 : date.getUTCDay();
  const monday = new Date(date.getTime());
  monday.setUTCDate(monday.getUTCDate() - (dayOfWeek - 1));
  return monday.toISOString().slice(0, 10);
}

/**
 * CloudFrontの月次配信量から課金額を推定する。無料枠(1TB/月)を超えた分だけに
 * 単価を掛ける。無料枠はアカウント単位のため、Sattori以外の配信がある場合は
 * 過小評価になる点に注意。
 */
export function estimateCloudFrontCost(deliveryBytes: number): {
  deliveryGb: number;
  overageGb: number;
  usd: number;
} {
  const deliveryGb = deliveryBytes / BYTES_PER_GB;
  const overageGb = Math.max(0, deliveryGb - CLOUDFRONT_FREE_TIER_GB_PER_MONTH);
  return { deliveryGb, overageGb, usd: overageGb * CLOUDFRONT_USD_PER_GB };
}
