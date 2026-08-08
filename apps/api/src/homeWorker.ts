import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { HOME_WORKER_OFFER_OPEN } from "@sattori/shared";
import type { JobRecord, WorkerEnvironment, WorkerHeartbeat } from "@sattori/shared";

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/**
 * 自宅ワーカー（Issue #49）へのジョブのオファーとその後始末。claim する側
 * （`home-worker/claim.py`）とここが同じ条件付き更新の約束を共有する:
 *
 * - オファー中: `homeWorkerOfferState = "open"` かつ `homeWorkerOfferExpiresAt` が未来。
 *   sparse GSI（`HomeWorkerOfferIndex`）に載るのはこの状態のジョブだけ。
 * - claim済み: `assignedWorkerId` が存在する。`homeWorkerOfferState` は消える
 *   （二重claim防止はこの2条件の組み合わせで担保する）。
 * - 撤回済み: どちらの属性も無い。以降EC2 Fleetが起動する。
 *
 * `assignedWorkerId` の有無が「誰がこのジョブの taskToken を持っているか」の唯一の
 * 真実であり、AWS側がこれを消すことがそのまま**claimの取り消し**になる
 * （デーモンは自分のIDが残っている間だけ実行を続ける）。
 */

/** GSI名。CDK（`infra/lib/sattori-stack.ts`）と自宅デーモンの双方が同じ名前を使う。 */
export const HOME_WORKER_OFFER_INDEX = "HomeWorkerOfferIndex";

/**
 * ワーカーのハートビート一覧を取得する。`WorkersTable` は常駐ワーカーの台数
 * （現状1台、将来も数台）ぶんしかアイテムを持たないため、GSIやQueryではなく
 * 素朴なScanで足りる（1リクエスト1ページで読み切れる規模）。
 */
export async function listWorkerHeartbeats(table: string): Promise<WorkerHeartbeat[]> {
  const result = await client.send(new ScanCommand({ TableName: table }));
  return (result.Items as WorkerHeartbeat[] | undefined) ?? [];
}

export interface OfferJobParams {
  jobsTable: string;
  jobId: string;
  /** ワーカーコンテナへ渡す環境変数（`workerEnv.ts`、`TASK_TOKEN`を含む）。 */
  env: WorkerEnvironment;
  /** オファーの期限（ISO 8601）。 */
  expiresAt: string;
}

/**
 * ジョブを自宅ワーカーへオファーする。既に誰かがclaim済みなら何もせず false を返す
 * （Step Functionsのリトライで`Launch`が再入したときに、走っているワーカーの
 * 割り当てを踏まないようにするための保険）。
 */
export async function offerJobToHomeWorker(params: OfferJobParams): Promise<boolean> {
  try {
    await client.send(
      new UpdateCommand({
        TableName: params.jobsTable,
        Key: { jobId: params.jobId },
        UpdateExpression:
          "SET homeWorkerOfferState = :open, homeWorkerOfferExpiresAt = :exp, homeWorkerEnv = :env, updatedAt = :u",
        ConditionExpression: "attribute_not_exists(assignedWorkerId)",
        ExpressionAttributeValues: {
          ":open": HOME_WORKER_OFFER_OPEN,
          ":exp": params.expiresAt,
          ":env": params.env,
          ":u": new Date().toISOString(),
        },
      }),
    );
    return true;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      return false;
    }
    throw err;
  }
}

/**
 * オファーを撤回する（＝EC2 Fleetへフォールバックする）。**claim済みなら撤回せず
 * false を返す**。オファー期限切れの判定とclaimは競合しうるため、「期限を過ぎたから
 * EC2を起動してよい」と決めてよいのは、この条件付き削除に成功したときだけである
 * （両方が走ると同じリプレイを2台で録画してしまう）。
 */
export async function withdrawHomeWorkerOffer(
  jobsTable: string,
  jobId: string,
): Promise<boolean> {
  try {
    await client.send(
      new UpdateCommand({
        TableName: jobsTable,
        Key: { jobId },
        UpdateExpression:
          "REMOVE homeWorkerOfferState, homeWorkerOfferExpiresAt, homeWorkerEnv SET updatedAt = :u",
        ConditionExpression: "attribute_not_exists(assignedWorkerId)",
        ExpressionAttributeValues: { ":u": new Date().toISOString() },
      }),
    );
    return true;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      return false;
    }
    throw err;
  }
}

/** ジョブをclaimしたワーカーのID（未claimなら null）。 */
export async function getAssignedWorkerId(
  jobsTable: string,
  jobId: string,
): Promise<string | null> {
  const result = await client.send(
    new GetCommand({
      TableName: jobsTable,
      Key: { jobId },
      ProjectionExpression: "assignedWorkerId",
      // claimされた直後を取りこぼすと無駄にEC2を起動してしまうため、
      // ここだけは結果整合性ではなく強い整合性で読む。
      ConsistentRead: true,
    }),
  );
  const assigned = (result.Item as Pick<JobRecord, "assignedWorkerId"> | undefined)
    ?.assignedWorkerId;
  return assigned ?? null;
}

/**
 * 自宅ワーカーへの割り当てを解除する（Step Functionsの失敗ハンドラから呼ぶ）。
 * `assignedWorkerId` を消すことで、走っている自宅ワーカーは次のジョブハートビート
 * （条件付き更新）で claim の取り消しに気づき、コンテナを停止する。EC2ワーカーに
 * 対する `TerminateInstances` と同じ役割を果たす、自宅ワーカー版の孤児掃除である。
 *
 * オファー中の属性も併せて落とす（撤回する前にLaunchがタイムアウト・クラッシュした
 * 場合に、期限切れのオファーがGSIへ残り続けるのを防ぐ）。
 */
export async function releaseHomeWorkerAssignment(
  jobsTable: string,
  jobId: string,
): Promise<void> {
  await client.send(
    new UpdateCommand({
      TableName: jobsTable,
      Key: { jobId },
      UpdateExpression:
        "REMOVE assignedWorkerId, homeWorkerOfferState, homeWorkerOfferExpiresAt, homeWorkerEnv SET updatedAt = :u",
      ExpressionAttributeValues: { ":u": new Date().toISOString() },
    }),
  );
}

/** ジョブがclaimされるまで（またはタイムアウトまで）待つ。 */
export interface WaitForClaimParams {
  jobsTable: string;
  jobId: string;
  /** 待機の締め切り（epochミリ秒）。 */
  deadline: number;
  /** ポーリング間隔（ミリ秒）。 */
  intervalMs: number;
  /** テスト用の差し替え口（既定は実時間のsleep）。 */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * オファーがclaimされるのをポーリングで待ち、claimしたワーカーIDを返す
 * （時間内にclaimされなければ null）。
 *
 * Lambdaを最大`offerWindowSeconds`ぶんブロックする素朴な実装にしている。
 * ステートマシンに Wait + Choice を足す方式だと、`waitForTaskToken` のトークンを
 * 発行する `Launch` タスクの外側でオファーを扱うことになり、「トークンを誰が
 * 持っているか」の見通しが悪くなる。月1000ジョブ・1回20秒程度ではLambdaの
 * 実行時間課金も無視できる（無料枠内）ため、状態機械を単純なまま保つ方を選んだ。
 */
export async function waitForHomeWorkerClaim(params: WaitForClaimParams): Promise<string | null> {
  const sleep = params.sleep ?? defaultSleep;
  const now = params.now ?? (() => Date.now());
  for (;;) {
    const assigned = await getAssignedWorkerId(params.jobsTable, params.jobId);
    if (assigned !== null) {
      return assigned;
    }
    const remaining = params.deadline - now();
    if (remaining <= 0) {
      return null;
    }
    await sleep(Math.min(params.intervalMs, remaining));
  }
}
