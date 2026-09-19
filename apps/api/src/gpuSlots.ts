import { ConditionalCheckFailedException, DynamoDBClient, TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { GPU_LEASE_ACTIVE_MINUTES, GPU_VCPU_QUOTA } from "@sattori/shared";

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/**
 * GPU録画ジョブのvCPU容量会計（Issue #270）。`GpuSlotsTable` に対する原子的な
 * 操作をここに集約する。
 *
 * ## テーブル構造
 *
 * PK=`slotKey`（定数`"gpu"`のみ）、SK=`itemKey`。単一パーティションに以下の
 * 2種類のアイテムが同居する:
 *
 * - カウンタアイテム（`itemKey = QUOTA_ITEM_KEY`）: `usedVcpu` を1件で持つ。
 * - リースアイテム（`itemKey = "job#<jobId>"`）: ジョブごとの確保量・期限。
 *
 * 単一パーティションなので `Query(slotKey="gpu", ConsistentRead: true)` 1回で
 * 台帳全体（カウンタ＋全リース）が強一貫で読める。
 *
 * ## なぜ「リース1件=1アイテム＋TransactWriteItems」なのか
 *
 * 「合計vCPUを単一アイテムに持ち`version`で楽観ロックする」案も検討したが、
 * リースごとの期限管理・リコンサイルが1アイテム内のマップの部分更新になり煩雑。
 * 1件=1アイテムなら `ConditionExpression` そのものが「クオータ超過禁止」を直接
 * 表現でき、期限切れ回収やリコンサイラ（`handlers/sweepOrphanInstances.ts`）も
 * 通常の `Query`+条件付き更新で素直に書ける。
 * 詳細は `docs/decisions/0056-gpu-vcpu-lease-and-queue.md` 参照。
 */

/** カウンタアイテムの `itemKey`。 */
const QUOTA_ITEM_KEY = "#quota";

/** リースアイテムの `itemKey` を組み立てる。 */
function leaseItemKey(jobId: string): string {
  return `job#${jobId}`;
}

/** GPU容量テーブルのパーティションキー（値は常にこれ1種類）。 */
const SLOT_PARTITION_KEY = "gpu";

/** リースのTTL属性に載せる余裕（削除は最大48時間遅延するため回収の主手段にはしない保険）。 */
const LEASE_TTL_BUFFER_SEC = 6 * 60 * 60;

export interface GpuLease {
  jobId: string;
  vcpu: number;
  acquiredAt: string;
  expiresAt: string;
  expectedFinishAt: string;
  instanceType?: string;
  instanceId?: string;
}

interface GpuLeaseItem extends GpuLease {
  slotKey: string;
  itemKey: string;
  ttl: number;
}

interface GpuQuotaItem {
  slotKey: string;
  itemKey: string;
  usedVcpu: number;
}

function isLeaseItem(item: GpuLeaseItem | GpuQuotaItem): item is GpuLeaseItem {
  return item.itemKey !== QUOTA_ITEM_KEY;
}

function leaseFromItem(item: GpuLeaseItem): GpuLease {
  return {
    jobId: item.jobId,
    vcpu: item.vcpu,
    acquiredAt: item.acquiredAt,
    expiresAt: item.expiresAt,
    expectedFinishAt: item.expectedFinishAt,
    instanceType: item.instanceType,
    instanceId: item.instanceId,
  };
}

function ttlFor(expiresAt: Date): number {
  return Math.floor(expiresAt.getTime() / 1000) + LEASE_TTL_BUFFER_SEC;
}

export type AcquireGpuSlotResult =
  | { kind: "acquired"; lease: GpuLease }
  | { kind: "no_capacity" };

/**
 * `reserve` vCPU分の枠を確保する。`Put`（リースアイテムの新規作成、
 * `attribute_not_exists(itemKey)` 条件）と `Update`（カウンタの加算、
 * `usedVcpu <= GPU_VCPU_QUOTA - reserve` 条件）を1つのトランザクションにまとめる
 * ことで、事前の空き容量チェックと実際の書き込みの間に割り込まれても過剰確保は
 * 起きない（最終的な安全性は常にこの `ConditionExpression` が保証する）。
 *
 * 同一jobIdへの再呼び出しは**冪等**——`Put`の条件不成立（＝自分のリースが既存）を
 * 検知したら、新規確保ではなく既存リースの期限延長として扱い `acquired` を返す
 * （Step Functionsの実行張り直し、Issue #132 経路への対応）。
 */
export async function acquireGpuSlot(
  table: string,
  jobId: string,
  reserve: number,
  now: Date,
  expectedFinishAt: Date,
): Promise<AcquireGpuSlotResult> {
  const acquiredAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + GPU_LEASE_ACTIVE_MINUTES * 60 * 1000);

  try {
    await client.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: table,
              Item: {
                slotKey: SLOT_PARTITION_KEY,
                itemKey: leaseItemKey(jobId),
                jobId,
                vcpu: reserve,
                acquiredAt,
                expiresAt: expiresAt.toISOString(),
                expectedFinishAt: expectedFinishAt.toISOString(),
                ttl: ttlFor(expiresAt),
              },
              ConditionExpression: "attribute_not_exists(itemKey)",
            },
          },
          {
            Update: {
              TableName: table,
              Key: { slotKey: SLOT_PARTITION_KEY, itemKey: QUOTA_ITEM_KEY },
              UpdateExpression: "SET usedVcpu = if_not_exists(usedVcpu, :zero) + :n",
              ConditionExpression: "attribute_not_exists(usedVcpu) OR usedVcpu <= :limit",
              ExpressionAttributeValues: {
                ":n": reserve,
                ":zero": 0,
                ":limit": GPU_VCPU_QUOTA - reserve,
              },
            },
          },
        ],
      }),
    );
    return {
      kind: "acquired",
      lease: {
        jobId,
        vcpu: reserve,
        acquiredAt,
        expiresAt: expiresAt.toISOString(),
        expectedFinishAt: expectedFinishAt.toISOString(),
      },
    };
  } catch (err) {
    if (err instanceof TransactionCanceledException) {
      // CancellationReasonsは各TransactItemに対応する順序で返る（[0]=Put, [1]=Update）。
      // Put側が条件不成立なら自分の既存リースがある＝冪等に「取得済み」として扱う。
      const putFailed =
        err.CancellationReasons?.[0]?.Code === "ConditionalCheckFailed";
      if (putFailed) {
        return await extendExistingLease(table, jobId, expiresAt, expectedFinishAt);
      }
      // Update側（カウンタ）が条件不成立、つまり空き容量不足。
      return { kind: "no_capacity" };
    }
    throw err;
  }
}

/**
 * 既存リースの期限を延長する（`acquireGpuSlot`の冪等パス）。リースが実際には
 * 消えていた場合（掃除役との競合、極めて稀）は新規確保を諦めて `no_capacity` を
 * 返す——次のポーリングで改めて空きがあれば取得できる。
 */
async function extendExistingLease(
  table: string,
  jobId: string,
  expiresAt: Date,
  expectedFinishAt: Date,
): Promise<AcquireGpuSlotResult> {
  try {
    const result = await client.send(
      new UpdateCommand({
        TableName: table,
        Key: { slotKey: SLOT_PARTITION_KEY, itemKey: leaseItemKey(jobId) },
        UpdateExpression: "SET expiresAt = :exp, expectedFinishAt = :fin, #ttl = :ttl",
        ConditionExpression: "attribute_exists(itemKey)",
        ExpressionAttributeNames: { "#ttl": "ttl" },
        ExpressionAttributeValues: {
          ":exp": expiresAt.toISOString(),
          ":fin": expectedFinishAt.toISOString(),
          ":ttl": ttlFor(expiresAt),
        },
        ReturnValues: "ALL_NEW",
      }),
    );
    const item = result.Attributes as GpuLeaseItem | undefined;
    if (!item) {
      return { kind: "no_capacity" };
    }
    return { kind: "acquired", lease: leaseFromItem(item) };
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      return { kind: "no_capacity" };
    }
    throw err;
  }
}

/**
 * このジョブのリース内容を取得する（存在しなければ null）。`Launch` が
 * `CreateFleet` の候補タイプを絞るための `maxVcpu` を導出するのに使う
 * （SFnのペイロードには乗せない設計。`docs/decisions/0056-gpu-vcpu-lease-and-queue.md`
 * 参照）。強一貫読み取り——直前の`acquireGpuSlot`の結果を確実に読む必要があるため。
 */
export async function getGpuLease(table: string, jobId: string): Promise<GpuLease | null> {
  const result = await client.send(
    new GetCommand({
      TableName: table,
      Key: { slotKey: SLOT_PARTITION_KEY, itemKey: leaseItemKey(jobId) },
      ConsistentRead: true,
    }),
  );
  const item = result.Item as GpuLeaseItem | undefined;
  return item ? leaseFromItem(item) : null;
}

/**
 * `CreateFleet` 成功後、実際に確保できたインスタンスタイプに合わせてリースの
 * vCPUを縮小する（例: 8vCPU仮予約→`g6f.xlarge`が取れたので4へ）。これにより
 * 残ったvCPUで別のジョブが並列に走れる（ADR 0046の「2台分の並列運用余地」）。
 *
 * 条件不一致（`oldVcpu`が想定と違う＝他の操作と競合した）は例外を投げず
 * ログのみに残す——**縮小の失敗自体はジョブを落とす理由にならない**。ただし
 * これを握りつぶしてよいのは、リコンサイラ（`handlers/sweepOrphanInstances.ts`）が
 * 実在インスタンスとの突き合わせで `usedVcpu` のドリフトを補正するため。
 */
export async function shrinkGpuLease(
  table: string,
  jobId: string,
  oldVcpu: number,
  newVcpu: number,
  instanceType: string,
  instanceId: string,
): Promise<void> {
  if (newVcpu >= oldVcpu) {
    return;
  }
  const delta = oldVcpu - newVcpu;
  try {
    await client.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: table,
              Key: { slotKey: SLOT_PARTITION_KEY, itemKey: leaseItemKey(jobId) },
              UpdateExpression: "SET vcpu = :new, instanceType = :t, instanceId = :i",
              ConditionExpression: "attribute_exists(itemKey) AND vcpu = :old",
              ExpressionAttributeValues: {
                ":new": newVcpu,
                ":old": oldVcpu,
                ":t": instanceType,
                ":i": instanceId,
              },
            },
          },
          {
            Update: {
              TableName: table,
              Key: { slotKey: SLOT_PARTITION_KEY, itemKey: QUOTA_ITEM_KEY },
              UpdateExpression: "SET usedVcpu = usedVcpu - :delta",
              ConditionExpression: "attribute_exists(usedVcpu) AND usedVcpu >= :delta",
              ExpressionAttributeValues: { ":delta": delta },
            },
          },
        ],
      }),
    );
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "gpu_lease_shrink_failed",
        jobId,
        oldVcpu,
        newVcpu,
        message: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

/**
 * リースを返却する。存在しない場合も成功扱い（冪等——非GPUジョブから呼んでも
 * 安全、掃除役による先行回収とも競合しない）。
 */
export async function releaseGpuSlot(table: string, jobId: string): Promise<void> {
  const existing = await client.send(
    new GetCommand({
      TableName: table,
      Key: { slotKey: SLOT_PARTITION_KEY, itemKey: leaseItemKey(jobId) },
      ConsistentRead: true,
    }),
  );
  const item = existing.Item as GpuLeaseItem | undefined;
  if (!item) {
    return;
  }
  try {
    await client.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Delete: {
              TableName: table,
              Key: { slotKey: SLOT_PARTITION_KEY, itemKey: leaseItemKey(jobId) },
              ConditionExpression: "attribute_exists(itemKey) AND vcpu = :vcpu",
              ExpressionAttributeValues: { ":vcpu": item.vcpu },
            },
          },
          {
            Update: {
              TableName: table,
              Key: { slotKey: SLOT_PARTITION_KEY, itemKey: QUOTA_ITEM_KEY },
              UpdateExpression: "SET usedVcpu = usedVcpu - :vcpu",
              ConditionExpression: "attribute_exists(usedVcpu) AND usedVcpu >= :vcpu",
              ExpressionAttributeValues: { ":vcpu": item.vcpu },
            },
          },
        ],
      }),
    );
  } catch (err) {
    if (err instanceof TransactionCanceledException) {
      // 既に返却済み（掃除役との競合等）。冪等に成功扱いにする。
      return;
    }
    throw err;
  }
}

export interface GpuSlotsSnapshot {
  usedVcpu: number;
  leases: GpuLease[];
}

/** カウンタ＋全リース一覧（期限切れ含む）。ETA計算・リコンサイラが使う。 */
export async function listGpuSlots(table: string): Promise<GpuSlotsSnapshot> {
  const result = await client.send(
    new QueryCommand({
      TableName: table,
      KeyConditionExpression: "slotKey = :k",
      ExpressionAttributeValues: { ":k": SLOT_PARTITION_KEY },
      ConsistentRead: true,
    }),
  );
  const items = (result.Items as Array<GpuLeaseItem | GpuQuotaItem>) ?? [];
  let usedVcpu = 0;
  const leases: GpuLease[] = [];
  for (const item of items) {
    if (item.itemKey === QUOTA_ITEM_KEY) {
      usedVcpu = (item as GpuQuotaItem).usedVcpu ?? 0;
    } else if (isLeaseItem(item)) {
      leases.push(leaseFromItem(item));
    }
  }
  return { usedVcpu, leases };
}

/**
 * リコンサイラ（`handlers/sweepOrphanInstances.ts`）専用。実測（生存インスタンスの
 * 実タイプ）に合わせてリースのvCPUを強制的に補正する（増減どちらも）。
 * `shrinkGpuLease()`と違い増加方向も扱う——「実測に合わせる」ことが目的であり、
 * 減らす方向だけを想定した`shrinkGpuLease()`の安全弁（`newVcpu >= oldVcpu`なら
 * 何もしない）は持たない。
 *
 * 条件不一致（他の操作との競合）・リース消失は例外を投げずログのみに残す
 * ——次回の掃除（10分後）で改めて補正すればよい。
 */
export async function repairGpuLeaseVcpu(
  table: string,
  jobId: string,
  observedVcpu: number,
): Promise<void> {
  const existing = await client.send(
    new GetCommand({
      TableName: table,
      Key: { slotKey: SLOT_PARTITION_KEY, itemKey: leaseItemKey(jobId) },
      ConsistentRead: true,
    }),
  );
  const item = existing.Item as GpuLeaseItem | undefined;
  if (!item || item.vcpu === observedVcpu) {
    return;
  }
  const delta = observedVcpu - item.vcpu;
  try {
    await client.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: table,
              Key: { slotKey: SLOT_PARTITION_KEY, itemKey: leaseItemKey(jobId) },
              UpdateExpression: "SET vcpu = :new",
              ConditionExpression: "attribute_exists(itemKey) AND vcpu = :old",
              ExpressionAttributeValues: { ":new": observedVcpu, ":old": item.vcpu },
            },
          },
          {
            Update: {
              TableName: table,
              Key: { slotKey: SLOT_PARTITION_KEY, itemKey: QUOTA_ITEM_KEY },
              UpdateExpression: "SET usedVcpu = if_not_exists(usedVcpu, :zero) + :delta",
              // usedVcpuが負になるのだけは避ける(delta<0=減算のときのみ効く条件)。
              ConditionExpression: "attribute_not_exists(usedVcpu) OR usedVcpu >= :floor",
              ExpressionAttributeValues: {
                ":delta": delta,
                ":zero": 0,
                ":floor": delta < 0 ? -delta : 0,
              },
            },
          },
        ],
      }),
    );
    console.log(
      JSON.stringify({
        event: "gpu_lease_vcpu_repaired",
        jobId,
        oldVcpu: item.vcpu,
        newVcpu: observedVcpu,
      }),
    );
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "gpu_lease_repair_failed",
        jobId,
        message: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

/**
 * リコンサイラ専用。リースが存在しないのに生存しているGPUインスタンスに対し、
 * 補完リースを作成する（安全側=クオータ超過側に倒す。実在するインスタンスの
 * vCPUを台帳に反映しないままにするほうが、他のジョブを誤って並列起動させる
 * リスクが大きい）。`acquireGpuSlot()`と違い空き容量チェックの条件式を持たない
 * ——これは新規確保ではなく「既に消費されている事実」の記録であるため。
 *
 * 既にリースが存在する場合（掃除の合間に本来の経路で確保された等）は何もしない。
 */
export async function createCompensatingGpuLease(
  table: string,
  jobId: string,
  vcpu: number,
  acquiredAt: Date,
): Promise<void> {
  const expiresAt = new Date(acquiredAt.getTime() + GPU_LEASE_ACTIVE_MINUTES * 60 * 1000);
  try {
    await client.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: table,
              Item: {
                slotKey: SLOT_PARTITION_KEY,
                itemKey: leaseItemKey(jobId),
                jobId,
                vcpu,
                acquiredAt: acquiredAt.toISOString(),
                expiresAt: expiresAt.toISOString(),
                expectedFinishAt: expiresAt.toISOString(),
                ttl: ttlFor(expiresAt),
              },
              ConditionExpression: "attribute_not_exists(itemKey)",
            },
          },
          {
            Update: {
              TableName: table,
              Key: { slotKey: SLOT_PARTITION_KEY, itemKey: QUOTA_ITEM_KEY },
              UpdateExpression: "SET usedVcpu = if_not_exists(usedVcpu, :zero) + :n",
              ExpressionAttributeValues: { ":n": vcpu, ":zero": 0 },
            },
          },
        ],
      }),
    );
    console.log(JSON.stringify({ event: "gpu_lease_compensated", jobId, vcpu }));
  } catch (err) {
    if (err instanceof TransactionCanceledException) {
      // 既にリースが存在する(本来の経路で確保済み)。何もせず終える。
      return;
    }
    console.error(
      JSON.stringify({
        event: "gpu_lease_compensation_failed",
        jobId,
        message: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}
