/**
 * 管理画面（`/admin/settings`、Issue #14）向けの運用設定。ジョブレコードとは別の
 * シングルトン設定（DynamoDBの`SettingsTable`に1件だけ持つ）で、`GET /magic-links`の
 * 受付可否を制御する。
 *
 * - `acceptingNewJobs`: **キルスイッチ**。falseにすると新規のマジックリンク要求
 *   （＝新規録画の受付）を即座に停止する。コストガードが発動するより前に、運用者が
 *   手動で全面停止できるようにするための機能（AGENTS.md「今後の展開・既知の制約」）。
 * - `monthlyCostLimitUsd`: **月間コストガード**の閾値（USD）。月間の録画「回数」では
 *   なく、既存の推定コスト機能（`cost.ts`の`estimateJobCost`）による当月の推定合計額
 *   が閾値に達したら新規受付を止める。今後、自宅サーバーを追加録画ワーカーとして
 *   導入する構想（Issue #49）でジョブ単価が一様でなくなる見込みのため、回数ではなく
 *   金額で制御する。
 */

/** `monthlyCostLimitUsd`の既定値（USD）。当面の目安として設定した金額。 */
export const DEFAULT_MONTHLY_COST_LIMIT_USD = 50;

/** 運用設定の現在値。 */
export interface AdminSettings {
  acceptingNewJobs: boolean;
  monthlyCostLimitUsd: number;
}

/** POST /admin/settings のリクエストボディ。指定したフィールドだけを更新する。 */
export interface UpdateAdminSettingsRequest {
  acceptingNewJobs?: boolean;
  monthlyCostLimitUsd?: number;
}

/**
 * GET/POST /admin/settings のレスポンス。設定値に加え、キルスイッチとは独立に
 * 「今まさにコストガードが働いているか」を判断できるよう、当月の推定コスト
 * （`cost.ts`の`estimateJobCost`を月次集計したもの、`GET /admin/costs`と同じ計算）も
 * 一緒に返す。
 */
export interface AdminSettingsResponse extends AdminSettings {
  /** 当月（UTC基準）の推定コスト合計（USD）。CloudFrontの無料枠超過分を含む。 */
  currentMonthCostUsd: number;
  /** `currentMonthCostUsd >= monthlyCostLimitUsd`。 */
  costLimitReached: boolean;
}
