import { randomBytes } from "node:crypto";
import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const SALT_KEY_PREFIX = "analyticsSalt#";

/**
 * saltのTTL(日)。当日のイベント処理には1日あれば足りるが、UTC日境界をまたぐ
 * 処理の揺れを吸収するため2日分残す(Issue #144)。
 */
const SALT_TTL_DAYS = 2;

/**
 * `date`(YYYY-MM-DD, UTC)用のハッシュ化saltを`SettingsTable`から取得する。
 * 無ければ生成して書き込む。複数Lambda実行が同時に初回アクセスしても、条件付き
 * `PutCommand`で最初の1件だけが採用され、後発は採用された値を読み直す
 * （`docs/decisions/0026-hashed-visitor-id-daily-salt.md`）。
 *
 * saltは日ごとに変わるため、この関数が返す値だけでは日をまたいだ訪問者の
 * 突き合わせはできない。
 */
export async function getOrCreateDailySalt(table: string, date: string): Promise<string> {
  const key = `${SALT_KEY_PREFIX}${date}`;

  const existing = await client.send(
    new GetCommand({ TableName: table, Key: { settingKey: key } }),
  );
  if (typeof existing.Item?.salt === "string") {
    return existing.Item.salt;
  }

  const salt = randomBytes(32).toString("hex");
  const ttl = Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000) + SALT_TTL_DAYS * 24 * 60 * 60;

  try {
    await client.send(
      new PutCommand({
        TableName: table,
        Item: { settingKey: key, salt, ttl },
        ConditionExpression: "attribute_not_exists(settingKey)",
      }),
    );
    return salt;
  } catch (err) {
    if (!(err instanceof ConditionalCheckFailedException)) {
      throw err;
    }
    // 他の実行が先にこの日のsaltを作った。その値を読み直して使う。
    const retry = await client.send(
      new GetCommand({ TableName: table, Key: { settingKey: key } }),
    );
    if (typeof retry.Item?.salt === "string") {
      return retry.Item.salt;
    }
    throw err;
  }
}
