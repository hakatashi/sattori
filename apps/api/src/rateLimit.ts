import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/** 24時間あたりの送信許可件数（マジックリンク新規送信・再送の合計）。 */
export const RATE_LIMIT_MAX_REQUESTS_PER_DAY = 5;

const RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000;
/** レコードのTTL。ウィンドウ経過後もリセット対象になるが、念のため少し余裕を持たせて自動削除する。 */
const RATE_LIMIT_TTL_BUFFER_SEC = 60 * 60;

/** 際限のない再試行を避けるための上限。呼び出しごとの実際の同時アクセス数はごく小さいため十分な余裕。 */
const MAX_CONTENTION_RETRIES = 5;

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
 * 直近24時間の送信回数が上限に達しているか判定し、達していなければこの呼び出し
 * 自体を1件としてカウンタに記録する。
 *
 * メールアドレスごとに1件のカウンタitem（`requestCount`/`windowStart`）を持ち、
 * 「件数チェック」と「記録」をDynamoDBの条件付き`UpdateCommand`1回に一本化する
 * ことで原子的に行う（旧実装はQuery→Putの2段階で、間隙に同時到着したリクエスト
 * 同士が互いのカウントを見落として上限を超えて許可してしまう競合状態があった）。
 *
 * ウィンドウは「そのメールで最初にカウントされた時刻から24時間」で、経過後は
 * 次のリクエストで自動的にリセットされる（固定ウィンドウ方式。「直近24時間の
 * 送信数を都度数え直す」厳密なスライディングウィンドウではないが、この規模の
 * サービスでは十分）。
 */
export async function checkAndRecordRateLimit(
  table: string,
  email: string,
): Promise<{ allowed: boolean }> {
  const normalizedEmail = normalizeEmailForRateLimit(email);

  for (let attempt = 0; attempt < MAX_CONTENTION_RETRIES; attempt++) {
    const now = Date.now();
    const windowFloor = new Date(now - RATE_LIMIT_WINDOW_MS).toISOString();
    const ttl = Math.floor(now / 1000) + RATE_LIMIT_WINDOW_MS / 1000 + RATE_LIMIT_TTL_BUFFER_SEC;

    // 有効なウィンドウが既にあり、かつ件数が上限未満の場合のみインクリメントする。
    try {
      await client.send(
        new UpdateCommand({
          TableName: table,
          Key: { normalizedEmail },
          UpdateExpression: "SET requestCount = requestCount + :one, ttl = :ttl",
          ConditionExpression: "windowStart > :windowFloor AND requestCount < :max",
          ExpressionAttributeValues: {
            ":one": 1,
            ":ttl": ttl,
            ":windowFloor": windowFloor,
            ":max": RATE_LIMIT_MAX_REQUESTS_PER_DAY,
          },
        }),
      );
      return { allowed: true };
    } catch (err) {
      if (!(err instanceof ConditionalCheckFailedException)) {
        throw err;
      }
    }

    // 上のインクリメントは条件不成立だった。itemが存在しないか、ウィンドウが
    // 失効しているなら、新しいウィンドウの1件目として作り直す。
    try {
      await client.send(
        new UpdateCommand({
          TableName: table,
          Key: { normalizedEmail },
          UpdateExpression: "SET requestCount = :one, windowStart = :now, ttl = :ttl",
          ConditionExpression: "attribute_not_exists(windowStart) OR windowStart <= :windowFloor",
          ExpressionAttributeValues: {
            ":one": 1,
            ":now": new Date(now).toISOString(),
            ":ttl": ttl,
            ":windowFloor": windowFloor,
          },
        }),
      );
      return { allowed: true };
    } catch (err) {
      if (!(err instanceof ConditionalCheckFailedException)) {
        throw err;
      }
      // ウィンドウのリセットも条件不成立 = 有効なウィンドウが存在するのに
      // 上のインクリメントには失敗した、ということは件数が既に上限に達している
      // か、他の並行リクエストが今まさにウィンドウを作り直した直後のいずれか。
      // 前者なら次のループのインクリメントも失敗して最終的に拒否される。
      // 後者なら次のループのインクリメントが成功する。
    }
  }

  // 同時アクセスが続き規定回数内で決着しなかった。フェイルクローズで拒否する。
  return { allowed: false };
}
