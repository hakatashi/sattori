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
 *
 * `options.unlessDone` を指定すると「status が done でないこと」を条件にした
 * 原子的更新になり、条件を満たさなかった場合は書き込まずに false を返す
 * （通常の更新は常に true）。ワーカーの完走とAPI側の書き込みが競合しうる箇所
 * （管理画面からの緊急停止など）で、確定した `done` を後から潰さないために使う。
 */
export async function updateJobStatus(
  table: string,
  jobId: string,
  status: JobStatus,
  error?: string,
  options?: { unlessDone?: boolean },
): Promise<boolean> {
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
  let conditionExpression: string | undefined;
  if (options?.unlessDone) {
    conditionExpression = "#s <> :done";
    expressionAttributeValues[":done"] = "done" satisfies JobStatus;
  }

  try {
    await client.send(
      new UpdateCommand({
        TableName: table,
        Key: { jobId },
        UpdateExpression: updateExpression,
        ConditionExpression: conditionExpression,
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues,
      }),
    );
    return true;
  } catch (err) {
    if (conditionExpression !== undefined && err instanceof ConditionalCheckFailedException) {
      return false;
    }
    throw err;
  }
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

export class JobAlreadyRetriedError extends Error {
  /** 既に記録されていた再実行先のジョブID（取得できた場合のみ）。 */
  readonly retriedToJobId: string | undefined;

  constructor(retriedToJobId: string | undefined) {
    super("job already retried");
    this.retriedToJobId = retriedToJobId;
  }
}

/**
 * 元ジョブに「管理画面から再実行して作成した新しいジョブのID」を原子的に予約する
 * （Issue #59）。元ジョブ詳細から新ジョブへ辿るための運用調査用リンクであると同時に、
 * **同一ジョブの多重再実行に対する排他**を兼ねる（二重クリックやリクエストの再送で
 * 同じリプレイを録画するEC2が2台走ると、そのぶん課金され、片方は元ジョブから
 * 辿れない追跡不能なジョブになる）。そのため実際にジョブを作る前に呼び、
 * 既に別の再実行先が記録されていれば`JobAlreadyRetriedError`を投げる。
 */
export async function claimJobRetryLink(
  table: string,
  jobId: string,
  retriedToJobId: string,
): Promise<void> {
  try {
    await client.send(
      new UpdateCommand({
        TableName: table,
        Key: { jobId },
        UpdateExpression: "SET retriedToJobId = :r, updatedAt = :u",
        // 未再実行のジョブは`retriedToJobId`が未設定か、明示的なnull(DynamoDBのNULL型。
        // `buildRetryJob`や`requestMagicLink`が書き込む)のどちらか。NULL型は`=`での
        // 比較が使えないため`attribute_type`で判定する。
        ConditionExpression:
          "attribute_not_exists(retriedToJobId) OR attribute_type(retriedToJobId, :nullType)",
        ExpressionAttributeValues: {
          ":r": retriedToJobId,
          ":u": new Date().toISOString(),
          ":nullType": "NULL",
        },
        ReturnValuesOnConditionCheckFailure: "ALL_OLD",
      }),
    );
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      const existing = err.Item
        ? (unmarshall(err.Item).retriedToJobId as string | undefined)
        : undefined;
      throw new JobAlreadyRetriedError(existing ?? undefined);
    }
    throw err;
  }
}

/**
 * `claimJobRetryLink`で予約した再実行先を取り消す（Step Functionsの起動に失敗した
 * 場合のロールバック）。自分が予約したIDのままである場合のみ取り消す。
 */
export async function releaseJobRetryLink(
  table: string,
  jobId: string,
  retriedToJobId: string,
): Promise<void> {
  try {
    await client.send(
      new UpdateCommand({
        TableName: table,
        Key: { jobId },
        UpdateExpression: "SET retriedToJobId = :null, updatedAt = :u",
        ConditionExpression: "retriedToJobId = :r",
        ExpressionAttributeValues: {
          ":r": retriedToJobId,
          ":null": null,
          ":u": new Date().toISOString(),
        },
      }),
    );
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      return;
    }
    throw err;
  }
}

/**
 * ジョブに紐づく実行中の EC2 インスタンスの情報（インスタンスID・実際に確保された
 * インスタンスタイプ・アベイラビリティゾーン）を記録する。instanceId は Step Functions
 * の失敗ハンドラ（handleFailure）がリトライ/タイムアウト時にどのインスタンスを
 * terminate すべきか判定するために使う。instanceType/availabilityZone は録画品質
 * （重複フレーム率）の分析・運用調査用。
 */
export async function updateJobInstance(
  table: string,
  jobId: string,
  instance: { instanceId: string; instanceType: string | null; availabilityZone: string | null },
): Promise<void> {
  await client.send(
    new UpdateCommand({
      TableName: table,
      Key: { jobId },
      UpdateExpression:
        "SET instanceId = :i, instanceType = :t, availabilityZone = :az, updatedAt = :u",
      ExpressionAttributeValues: {
        ":i": instance.instanceId,
        ":t": instance.instanceType,
        ":az": instance.availabilityZone,
        ":u": new Date().toISOString(),
      },
    }),
  );
}
