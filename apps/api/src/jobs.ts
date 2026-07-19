import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import type { JobRecord, JobStatus } from "@sattori/shared";

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/**
 * "pending"状態のジョブが録画開始("POST /jobs/{jobId}/start")を受け付ける期限。
 * メール未確認のジョブを無期限に残さないための、bot/濫用対策としての期限
 * （アップロード用S3バケットの自動削除とは現在は独立）。
 */
export const PENDING_JOB_TTL_MS = 24 * 60 * 60 * 1000;

/** ジョブレコードを新規作成する。 */
export async function putJob(table: string, job: JobRecord): Promise<void> {
  await client.send(
    new PutCommand({
      TableName: table,
      Item: job,
      ConditionExpression: "attribute_not_exists(jobId)",
    }),
  );
}

/**
 * ジョブレコードを削除する。マジックリンク送信要求でジョブを作成した後、
 * メール送信自体が失敗した場合のロールバック用（requestMagicLink.ts）。
 */
export async function deleteJob(table: string, jobId: string): Promise<void> {
  await client.send(new DeleteCommand({ TableName: table, Key: { jobId } }));
}

/** ジョブレコードを取得する。存在しなければ null。 */
export async function getJob(table: string, jobId: string): Promise<JobRecord | null> {
  const result = await client.send(
    new GetCommand({ TableName: table, Key: { jobId } }),
  );
  return (result.Item as JobRecord | undefined) ?? null;
}

/**
 * ジョブの状態を更新する（ワーカーからも同じテーブルを更新するが、
 * API 側では主に起動直後の launching への遷移で使う）。
 * error を渡すと JobRecord.error（ユーザー表示用の簡潔な文言）も併せて更新する。
 */
export async function updateJobStatus(
  table: string,
  jobId: string,
  status: JobStatus,
  error?: string,
): Promise<void> {
  let updateExpression = "SET #s = :s, updatedAt = :u";
  const expressionAttributeNames: Record<string, string> = { "#s": "status" };
  const expressionAttributeValues: Record<string, unknown> = {
    ":s": status,
    ":u": new Date().toISOString(),
  };
  if (error !== undefined) {
    updateExpression += ", #e = :e";
    expressionAttributeNames["#e"] = "error";
    expressionAttributeValues[":e"] = error;
  }

  await client.send(
    new UpdateCommand({
      TableName: table,
      Key: { jobId },
      UpdateExpression: updateExpression,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
    }),
  );
}

export class JobAlreadyStartedError extends Error {
  /** 条件チェック失敗時点での既存ジョブの状態（取得できた場合のみ）。 */
  readonly currentStatus: JobStatus | undefined;

  constructor(currentStatus: JobStatus | undefined) {
    super("job already started");
    this.currentStatus = currentStatus;
  }
}

/**
 * "pending"(マジックリンク送信済み・未起動)から"queued"(起動)へ原子的に遷移させる。
 * 同一jobIdに対して複数回呼ばれても録画が起動するのは最初の1回だけになるよう、
 * DynamoDBの`ConditionExpression`で「まだpendingであること」を保証する
 * （並行アクセス・二重クリックへの対策。Issue #9）。既にpendingでなければ
 * （＝起動済みなら）`JobAlreadyStartedError`を投げるので、呼び出し側は
 * それを「エラーではなく起動済み」として扱ってよい。`ReturnValuesOnConditionCheckFailure`
 * で条件チェック失敗時点の既存itemを一緒に取得し、呼び出し側が改めて`getJob`を
 * 呼ばずに済むようにする。
 */
export async function startPendingJob(table: string, jobId: string): Promise<void> {
  try {
    await client.send(
      new UpdateCommand({
        TableName: table,
        Key: { jobId },
        UpdateExpression: "SET #s = :queued, updatedAt = :u",
        ConditionExpression: "#s = :pending",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":queued": "queued" satisfies JobStatus,
          ":pending": "pending" satisfies JobStatus,
          ":u": new Date().toISOString(),
        },
        ReturnValuesOnConditionCheckFailure: "ALL_OLD",
      }),
    );
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      const currentStatus = err.Item ? (unmarshall(err.Item).status as JobStatus) : undefined;
      throw new JobAlreadyStartedError(currentStatus);
    }
    throw err;
  }
}

/**
 * ジョブに紐づく実行中の EC2 インスタンスIDを記録する。
 * Step Functions の失敗ハンドラ（handleFailure）がリトライ/タイムアウト時に
 * どのインスタンスを terminate すべきか判定するために使う。
 */
export async function updateJobInstanceId(
  table: string,
  jobId: string,
  instanceId: string,
): Promise<void> {
  await client.send(
    new UpdateCommand({
      TableName: table,
      Key: { jobId },
      UpdateExpression: "SET instanceId = :i, updatedAt = :u",
      ExpressionAttributeValues: {
        ":i": instanceId,
        ":u": new Date().toISOString(),
      },
    }),
  );
}
