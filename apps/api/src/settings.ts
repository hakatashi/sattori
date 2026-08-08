import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { DEFAULT_MONTHLY_COST_LIMIT_USD } from "@sattori/shared";
import type { AdminSettings, UpdateAdminSettingsRequest } from "@sattori/shared";

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/**
 * 運用設定（キルスイッチ・月間コストガード閾値、Issue #14）を保持する`SettingsTable`。
 * PKは固定値の1件のみ持つシングルトン設定（ジョブ・レート制限カウンタのように
 * キー単位で増える性質のデータではないため、専用の小さいテーブルに分離した）。
 */
const SETTINGS_KEY = "global";

const DEFAULT_SETTINGS: AdminSettings = {
  acceptingNewJobs: true,
  monthlyCostLimitUsd: DEFAULT_MONTHLY_COST_LIMIT_USD,
};

/** 設定を取得する。デプロイ直後などitemが存在しない場合は既定値を返す。 */
export async function getSettings(table: string): Promise<AdminSettings> {
  const result = await client.send(
    new GetCommand({ TableName: table, Key: { settingKey: SETTINGS_KEY } }),
  );
  if (!result.Item) {
    return DEFAULT_SETTINGS;
  }
  return {
    acceptingNewJobs: result.Item.acceptingNewJobs ?? DEFAULT_SETTINGS.acceptingNewJobs,
    monthlyCostLimitUsd: result.Item.monthlyCostLimitUsd ?? DEFAULT_SETTINGS.monthlyCostLimitUsd,
  };
}

/**
 * 設定を部分更新する。管理者は1人固定で更新頻度も低いため、単純な
 * 読み取り→マージ→上書きで実装している（`rateLimit.ts`のような高頻度・複数呼び出し元
 * からの原子的更新は不要）。
 */
export async function updateSettings(
  table: string,
  patch: UpdateAdminSettingsRequest,
): Promise<AdminSettings> {
  const current = await getSettings(table);
  const next: AdminSettings = {
    acceptingNewJobs: patch.acceptingNewJobs ?? current.acceptingNewJobs,
    monthlyCostLimitUsd: patch.monthlyCostLimitUsd ?? current.monthlyCostLimitUsd,
  };
  await client.send(
    new PutCommand({ TableName: table, Item: { settingKey: SETTINGS_KEY, ...next } }),
  );
  return next;
}
