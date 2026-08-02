import { BYTES_PER_GB, usdToJpy, USD_TO_JPY_RATE, USD_TO_JPY_RATE_AS_OF } from "@sattori/shared";
import type { BilledDurationSource, SpotPriceSource } from "@sattori/shared";
import type { CostCurrency } from "./adminCurrency.ts";

/**
 * 管理画面のコスト表示（Issue #60）の書式ヘルパー。ジョブ詳細のコストパネルと
 * コスト集計ページで同じ見た目にするため共有する。
 */

/**
 * USD表示。1ジョブぶんは$0.04程度と小さいため、既定で小数4桁まで出す
 * （2桁だと個別ジョブがほぼ`$0.04`に潰れて大小が読めない）。集計値は
 * `digits: 2`で呼ぶ。
 */
export function formatUsd(value: number, digits = 4): string {
  return `$${value.toFixed(digits)}`;
}

/**
 * 円表示。1円は約1/157ドルなので、同じ情報量を保つには**USDより小数を2桁減らす**
 * のが釣り合う（$0.0360 → ¥5.65、$0.17 → ¥27）。桁区切りを入れるのは、月次集計が
 * 数千円〜数万円になったときに桁を読み違えないため。
 */
export function formatJpy(usd: number, usdDigits = 4): string {
  const digits = Math.max(0, usdDigits - 2);
  const value = usdToJpy(usd);
  return `¥${value.toLocaleString("ja-JP", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}

/**
 * 表示通貨に応じて金額を整形する。`digits`は**USD基準の小数桁数**で、円のときは
 * `formatJpy`が桁を落とす。値はどちらの通貨でもUSDで受け取る（計算はUSDのまま行い、
 * 表示の直前でだけ換算するという方針。`adminCurrency.ts`参照）。
 */
export function formatMoney(usd: number, currency: CostCurrency, digits = 4): string {
  return currency === "jpy" ? formatJpy(usd, digits) : formatUsd(usd, digits);
}

/**
 * 円表示時に添える注記。AWSの請求はUSD建てで、円換算のレートは請求時にAWS（と
 * カード会社）が決めるため、ここの円は「桁を掴むための概算」でしかないことを
 * 画面上で明示する。
 */
export const JPY_RATE_NOTE = `円は $1 = ¥${USD_TO_JPY_RATE}（${USD_TO_JPY_RATE_AS_OF}時点）の固定レートで換算した概算で、AWSが請求時に適用する実際のレートとは異なります。`;

/** バイト数を MiB / GiB で読みやすく表示する。 */
export function formatBytes(bytes: number): string {
  if (bytes <= 0) {
    return "-";
  }
  const gib = bytes / BYTES_PER_GB;
  if (gib >= 1) {
    return `${gib.toFixed(2)} GiB`;
  }
  return `${(bytes / 1024 ** 2).toFixed(0)} MiB`;
}

/** 秒数を「1時間5分」「35分12秒」のように表示する。 */
export function formatDuration(seconds: number): string {
  if (seconds <= 0) {
    return "0秒";
  }
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  if (hours > 0) {
    return `${hours}時間${minutes}分`;
  }
  if (minutes > 0) {
    return `${minutes}分${rest}秒`;
  }
  return `${rest}秒`;
}

/** 課金対象時間の根拠を日本語の注記にする（推定の確からしさをUIに出すため）。 */
export const BILLED_DURATION_LABEL: Record<BilledDurationSource, string> = {
  measured: "実測（起動〜終了）",
  running: "実行中のため現在時刻まで（増加中）",
  assumed: "起動時刻未記録のため実績平均で代用",
  "not-launched": "EC2未起動",
};

/** Spot単価の根拠を日本語の注記にする。 */
export const SPOT_PRICE_LABEL: Record<SpotPriceSource, string> = {
  recorded: "起動時に記録した実測値",
  "fallback-instance-type": "未記録のためインスタンスタイプ帯の平均値",
  "fallback-game": "未記録のためゲームから推定したサイズ帯の平均値",
};

/** コスト内訳の項目名（`CostBreakdown`のキー順に表示するため配列で持つ）。 */
export const COST_ITEM_LABELS = [
  ["ec2Spot", "EC2 Spot"],
  ["s3Storage", "S3 保管"],
  ["publicIpv4", "パブリックIPv4"],
  ["ebs", "EBS (gp3)"],
  ["misc", "その他(Lambda/SFN/DynamoDB/SES)"],
] as const;
