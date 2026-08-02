import { BYTES_PER_GB } from "@sattori/shared";
import type { BilledDurationSource, SpotPriceSource } from "@sattori/shared";

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
