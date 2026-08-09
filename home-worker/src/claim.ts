/**
 * オファーの探索とclaim（Issue #49）。
 *
 * AWS側（`apps/api/src/homeWorker.ts`）と対になる条件付き更新の約束:
 *
 * - オファー中のジョブは `homeWorkerOfferState = "open"` と
 *   `homeWorkerOfferExpiresAt`（未来）を持ち、sparse GSI `HomeWorkerOfferIndex` に載る。
 * - claim は「まだオファー中で、期限内で、誰も取っていない」ことを条件にした
 *   UpdateItem。DynamoDBの条件付き更新は原子的なので、複数ワーカー・複数ジョブが
 *   同じジョブを取り合っても成功するのは1つだけになる。
 * - claim後は `assignedWorkerId` が「誰がこのジョブのtaskTokenを持っているか」の
 *   唯一の真実。**AWS側がこの属性を消すことがclaimの取り消し**を意味するので、
 *   実行中は定期的に「自分のIDのままか」を条件にしたハートビートを打ち、条件が
 *   崩れたらコンテナを停止する（`daemon.ts`）。
 *
 * 属性名・条件式は AWS 側と噛み合っている契約そのものなので、意味を変える場合は
 * `apps/api/src/homeWorker.ts` / `handlers/sfn/launch.ts` /
 * `handlers/sfn/handleFailure.ts` / `handlers/admin/stopJob.ts` を必ず併せて確認すること。
 */
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { HOME_WORKER_OFFER_INDEX, HOME_WORKER_OFFER_OPEN } from "@sattori/shared";
import type { JobRecord } from "@sattori/shared";

function nowIso(): string {
  return new Date().toISOString();
}

/** 条件チェック失敗だけを「起きて当然の分岐」として扱い、それ以外は投げ直す。 */
function isConditionalFailure(err: unknown): boolean {
  return err instanceof ConditionalCheckFailedException;
}

/**
 * オファー中（期限内）のジョブを古い順に返す。
 *
 * sparse GSI なのでインデックスに載っているのはオファー中のジョブだけ。
 * 期限切れのオファー（AWS側が撤回する前にLambdaが落ちた等）を掴んでも
 * claimの条件式で弾かれるが、無駄なUpdateItemを避けるためここでも絞る。
 *
 * GSIの射影は ALL なので、返るアイテムはジョブレコードそのものとして扱ってよい
 * （`infra/lib/sattori-stack.ts`）。
 */
export async function findOpenOffers(
  client: DynamoDBDocumentClient,
  jobsTable: string,
  limit = 10,
): Promise<JobRecord[]> {
  const result = await client.send(
    new QueryCommand({
      TableName: jobsTable,
      IndexName: HOME_WORKER_OFFER_INDEX,
      KeyConditionExpression:
        "homeWorkerOfferState = :open AND homeWorkerOfferExpiresAt > :now",
      ExpressionAttributeValues: { ":open": HOME_WORKER_OFFER_OPEN, ":now": nowIso() },
      Limit: limit,
    }),
  );
  return (result.Items as JobRecord[] | undefined) ?? [];
}

/**
 * ジョブを原子的にclaimする。取れなければ null、取れたら更新後のジョブレコード。
 *
 * 同時に次の3つを1回の更新で済ませる:
 *
 * - `workerKind` を `home` にする（コスト推定がこの値でEC2課金の有無を分岐するため。
 *   `packages/shared/src/cost.ts`）。
 * - `status` を `launching` にする。**claimした側が状態も進める**ことで、AWS側が
 *   後からstatusを書く経路を作らずに済む（後追いで書くと、先に走り出した
 *   コンテナの `recording` を上書きしてしまう競合が生まれる）。
 * - オファーのマーカーを消してGSIから外し、他のワーカーが同じジョブを見に来ない
 *   ようにする。
 *
 * `homeWorkerEnv`（ワーカーコンテナへ渡す環境変数）は実行に必要なので残す。
 */
export async function claimJob(
  client: DynamoDBDocumentClient,
  jobsTable: string,
  jobId: string,
  workerId: string,
): Promise<JobRecord | null> {
  try {
    const result = await client.send(
      new UpdateCommand({
        TableName: jobsTable,
        Key: { jobId },
        UpdateExpression:
          "SET assignedWorkerId = :w, workerKind = :kind, #s = :launching, " +
          "homeWorkerHeartbeatAt = :now, updatedAt = :now " +
          "REMOVE homeWorkerOfferState",
        ConditionExpression:
          "homeWorkerOfferState = :open AND homeWorkerOfferExpiresAt > :now " +
          "AND attribute_not_exists(assignedWorkerId)",
        // "status" はDynamoDBの予約語のためプレースホルダが要る。
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":w": workerId,
          ":kind": "home",
          ":launching": "launching",
          ":open": HOME_WORKER_OFFER_OPEN,
          ":now": nowIso(),
        },
        ReturnValues: "ALL_NEW",
      }),
    );
    return (result.Attributes as JobRecord | undefined) ?? null;
  } catch (err) {
    if (isConditionalFailure(err)) {
      return null;
    }
    throw err;
  }
}

/**
 * claimが自分のものであることを確認しつつ、生存時刻を更新する。
 *
 * false を返したら **claimが取り消された**（AWS側の `HandleFailure`・管理画面からの
 * 緊急停止が `assignedWorkerId` を消した）ということ。呼び出し側はコンテナを
 * 停止しなければならない——放置すると、既に別経路でリトライが始まっているジョブを
 * 二重に録画してしまう。
 */
export async function touchClaim(
  client: DynamoDBDocumentClient,
  jobsTable: string,
  jobId: string,
  workerId: string,
): Promise<boolean> {
  try {
    await client.send(
      new UpdateCommand({
        TableName: jobsTable,
        Key: { jobId },
        UpdateExpression: "SET homeWorkerHeartbeatAt = :now",
        ConditionExpression: "assignedWorkerId = :w",
        ExpressionAttributeValues: { ":w": workerId, ":now": nowIso() },
      }),
    );
  } catch (err) {
    if (isConditionalFailure(err)) {
      return false;
    }
    throw err;
  }
  return true;
}

/**
 * 自分のclaimを手放す（コンテナを起動できなかった場合の後始末）。
 *
 * 自分が持っている場合のみ解除する。既に別経路で解除・再割り当てされていれば
 * 何もしない（条件チェック失敗は正常系）。
 */
export async function releaseClaim(
  client: DynamoDBDocumentClient,
  jobsTable: string,
  jobId: string,
  workerId: string,
): Promise<void> {
  try {
    await client.send(
      new UpdateCommand({
        TableName: jobsTable,
        Key: { jobId },
        UpdateExpression: "SET updatedAt = :now REMOVE assignedWorkerId, homeWorkerEnv",
        ConditionExpression: "assignedWorkerId = :w",
        ExpressionAttributeValues: { ":w": workerId, ":now": nowIso() },
      }),
    );
  } catch (err) {
    if (!isConditionalFailure(err)) {
      throw err;
    }
  }
}

/**
 * 使い終わったコンテナ環境変数（taskTokenを含む）をジョブレコードから消す。
 *
 * taskTokenは一度きりの使い捨てだが、管理画面はジョブレコードをそのまま表示する
 * ため、使用済みトークンを残す意味は無い。`assignedWorkerId` は運用調査のために
 * 残す（どのワーカーが処理したかの記録）。
 */
export async function clearWorkerEnv(
  client: DynamoDBDocumentClient,
  jobsTable: string,
  jobId: string,
  workerId: string,
): Promise<void> {
  try {
    await client.send(
      new UpdateCommand({
        TableName: jobsTable,
        Key: { jobId },
        UpdateExpression: "REMOVE homeWorkerEnv",
        ConditionExpression: "assignedWorkerId = :w",
        ExpressionAttributeValues: { ":w": workerId },
      }),
    );
  } catch (err) {
    if (!isConditionalFailure(err)) {
      throw err;
    }
  }
}
