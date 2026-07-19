import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { GameId, RecordingOptions } from "@sattori/shared";

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/** マジックリンクの有効期限（作成から24時間、Issue #9要件）。 */
export const MAGIC_LINK_TTL_MS = 24 * 60 * 60 * 1000;
/** DynamoDBのTTL属性は期限切れ後もすぐには削除されないため、判定より少し長く持たせる。 */
const MAGIC_LINK_TTL_BUFFER_SEC = 60 * 60;

/**
 * `POST /magic-links` の送信要求内容を、確認（`POST /jobs/{jobId}/confirm`）まで
 * 保持しておくレコード。ジョブ本体（JobRecord）はこの時点ではまだ作らない。
 */
export interface MagicLink {
  token: string;
  jobId: string;
  /** 送信先の生のメールアドレス（レート制限判定用の正規化はしない）。 */
  email: string;
  replayKey: string;
  game: GameId;
  options: RecordingOptions;
  estimatedDurationSeconds: number | null;
  createdAt: string;
  /** ISO 8601。この時刻を過ぎたら `confirm`/`resend` は拒否する。 */
  expiresAt: string;
  /** 単回使用の消費済みマーカー。未使用なら null。 */
  usedAt: string | null;
}

function ttlAttribute(expiresAtMs: number): number {
  return Math.floor(expiresAtMs / 1000) + MAGIC_LINK_TTL_BUFFER_SEC;
}

export async function putMagicLink(
  table: string,
  link: Omit<MagicLink, "createdAt" | "expiresAt" | "usedAt">,
): Promise<MagicLink> {
  const now = Date.now();
  const record: MagicLink = {
    ...link,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + MAGIC_LINK_TTL_MS).toISOString(),
    usedAt: null,
  };
  await client.send(
    new PutCommand({
      TableName: table,
      Item: { ...record, ttl: ttlAttribute(now + MAGIC_LINK_TTL_MS) },
      ConditionExpression: "attribute_not_exists(#token)",
      ExpressionAttributeNames: { "#token": "token" },
    }),
  );
  return record;
}

export async function getMagicLink(table: string, token: string): Promise<MagicLink | null> {
  const result = await client.send(new GetCommand({ TableName: table, Key: { token } }));
  return (result.Item as MagicLink | undefined) ?? null;
}

/**
 * トークンを単回使用として確定する。並行リクエストによる二重使用を防ぐため、
 * 「未使用であること」を条件にした原子的な更新で行う。既に使用済みなら
 * `ConditionalCheckFailedException` を投げるので、呼び出し側で捕捉して
 * 「使用済み」エラーとして扱う。
 */
export async function markMagicLinkUsed(table: string, token: string): Promise<void> {
  try {
    await client.send(
      new UpdateCommand({
        TableName: table,
        Key: { token },
        UpdateExpression: "SET usedAt = :u",
        ConditionExpression: "attribute_exists(#token) AND usedAt = :null",
        ExpressionAttributeNames: { "#token": "token" },
        ExpressionAttributeValues: { ":u": new Date().toISOString(), ":null": null },
      }),
    );
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      throw new MagicLinkAlreadyUsedError();
    }
    throw err;
  }
}

export class MagicLinkAlreadyUsedError extends Error {
  constructor() {
    super("magic link already used");
  }
}

/** 再送のため有効期限を現在時刻から24時間先へ延長する（トークン自体・リンクURLは変えない）。 */
export async function extendMagicLinkExpiry(table: string, token: string): Promise<string> {
  const now = Date.now();
  const expiresAt = new Date(now + MAGIC_LINK_TTL_MS).toISOString();
  await client.send(
    new UpdateCommand({
      TableName: table,
      Key: { token },
      UpdateExpression: "SET expiresAt = :e, #ttl = :ttl",
      ExpressionAttributeNames: { "#ttl": "ttl" },
      ExpressionAttributeValues: { ":e": expiresAt, ":ttl": ttlAttribute(now + MAGIC_LINK_TTL_MS) },
    }),
  );
  return expiresAt;
}
