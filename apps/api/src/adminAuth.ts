import { createHash, timingSafeEqual } from "node:crypto";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { required } from "./config.js";

const ssm = new SSMClient({});

/**
 * 管理画面(`/admin`)のLambda Authorizer(`handlers/admin/authorizer.ts`)が使う
 * トークン検証ロジック。ハンドラから分離してテスト容易性を確保する（Issue #51）。
 *
 * トークン自体はCDK/CloudFormationでは作成できないSSM Parameter Store(SecureString)
 * に手動で置く（`infra/README.md`参照）。jobIdによる認可（AGENTS.md）とは別系統の、
 * 管理者1人だけを想定した共有シークレット方式。
 */

/** SSMから取得したトークンをLambda実行コンテキストにキャッシュしておく期間。 */
export const ADMIN_TOKEN_CACHE_TTL_MS = 5 * 60 * 1000;

let cachedToken: string | null = null;
let cachedAt = 0;

/**
 * `Authorization: Bearer <token>` ヘッダーからトークン部分を取り出す。
 * schemeの大文字小文字は区別しない。ヘッダーが無い・形式が違う場合は null。
 */
export function extractBearerToken(
  headers: Record<string, string | undefined> | undefined,
): string | null {
  const raw = headers?.authorization ?? headers?.Authorization;
  if (!raw) {
    return null;
  }
  const match = /^Bearer\s+(.+)$/i.exec(raw);
  return match?.[1]?.trim() || null;
}

/** テスト用: モジュールスコープのキャッシュをリセットする。 */
export function resetAdminTokenCache(): void {
  cachedToken = null;
  cachedAt = 0;
}

async function loadAdminToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken !== null && now - cachedAt < ADMIN_TOKEN_CACHE_TTL_MS) {
    return cachedToken;
  }
  const result = await ssm.send(
    new GetParameterCommand({
      Name: required("ADMIN_TOKEN_PARAMETER_NAME"),
      WithDecryption: true,
    }),
  );
  const value = result.Parameter?.Value;
  if (!value) {
    throw new Error("管理画面用トークンがSSMに設定されていません");
  }
  cachedToken = value;
  cachedAt = now;
  return value;
}

/** 定数時間で文字列を比較する（SHA-256を経由し、長さの違いによる早期returnを避ける）。 */
function constantTimeEquals(a: string, b: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();
  return timingSafeEqual(digest(a), digest(b));
}

/**
 * 提示されたトークンがSSMに登録された管理者トークンと一致するか検証する。
 * SSMの取得に失敗した場合も例外を投げず false（deny）を返す
 * （authorizerが例外で落ちるとAPI Gatewayが500系の不透明なエラーになるため、
 * 呼び出し側で確実に deny として扱えるようにする）。
 */
export async function isValidAdminToken(presented: string | null): Promise<boolean> {
  if (!presented) {
    return false;
  }
  try {
    const expected = await loadAdminToken();
    return constantTimeEquals(presented, expected);
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "admin_token_load_failed",
        message: err instanceof Error ? err.message : String(err),
      }),
    );
    return false;
  }
}
