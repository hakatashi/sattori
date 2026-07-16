import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { JobRecord, JobStatus } from "@sattori/shared";

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

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
 */
export async function updateJobStatus(
  table: string,
  jobId: string,
  status: JobStatus,
): Promise<void> {
  await client.send(
    new UpdateCommand({
      TableName: table,
      Key: { jobId },
      UpdateExpression: "SET #s = :s, updatedAt = :u",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":s": status,
        ":u": new Date().toISOString(),
      },
    }),
  );
}
