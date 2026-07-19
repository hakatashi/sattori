import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/** 24時間あたりの送信許可件数（マジックリンク新規送信・再送の合計）。 */
export const RATE_LIMIT_MAX_REQUESTS_PER_DAY = 5;

const RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000;
/** レコードのTTL。ウィンドウ経過後もクエリの範囲外になるが、念のため少し余裕を持たせて自動削除する。 */
const RATE_LIMIT_TTL_BUFFER_SEC = 60 * 60;

/**
 * レート制限判定用にメールアドレスを正規化する。
 * `aaa@ccc.com` と `aaa+bbb@ccc.com` を同一視するため、大文字小文字を無視した上で
 * ローカル部の `+` 以降を除去する（Gmailのドット無視等、他のエイリアス規則は対象外）。
 * 実際の送信先（SESの to）にはこの正規化前の生のメールアドレスを使うこと。
 */
export function normalizeEmailForRateLimit(email: string): string {
  const lower = email.trim().toLowerCase();
  const atIndex = lower.lastIndexOf("@");
  if (atIndex === -1) {
    return lower;
  }
  const localPart = lower.slice(0, atIndex);
  const domain = lower.slice(atIndex);
  const plusIndex = localPart.indexOf("+");
  const normalizedLocalPart = plusIndex === -1 ? localPart : localPart.slice(0, plusIndex);
  return `${normalizedLocalPart}${domain}`;
}

/**
 * 直近24時間の送信回数が上限に達しているか判定する。
 * 上限未満であれば、この呼び出し自体を1件としてカウンタに記録する
 * （呼び出し側は判定がtrueを返した後に実際のメール送信へ進んでよい）。
 */
export async function checkAndRecordRateLimit(
  table: string,
  email: string,
): Promise<{ allowed: boolean }> {
  const normalizedEmail = normalizeEmailForRateLimit(email);
  const now = Date.now();
  const windowStart = new Date(now - RATE_LIMIT_WINDOW_MS).toISOString();

  const result = await client.send(
    new QueryCommand({
      TableName: table,
      KeyConditionExpression: "normalizedEmail = :e AND requestId >= :windowStart",
      ExpressionAttributeValues: {
        ":e": normalizedEmail,
        ":windowStart": windowStart,
      },
      Select: "COUNT",
    }),
  );

  if ((result.Count ?? 0) >= RATE_LIMIT_MAX_REQUESTS_PER_DAY) {
    return { allowed: false };
  }

  await client.send(
    new PutCommand({
      TableName: table,
      Item: {
        normalizedEmail,
        // ISO時刻を先頭に持つことで requestId のソート順がそのまま時系列になり、
        // 上記クエリの範囲指定（>= windowStart）が機能する。
        requestId: `${new Date(now).toISOString()}#${randomUUID()}`,
        ttl: Math.floor(now / 1000) + RATE_LIMIT_WINDOW_MS / 1000 + RATE_LIMIT_TTL_BUFFER_SEC,
      },
    }),
  );

  return { allowed: true };
}
