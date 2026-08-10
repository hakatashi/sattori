import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ADMIN_JOB_LIST_DEFAULT_LIMIT, ADMIN_JOB_LIST_MAX_LIMIT, JOB_STATUSES } from "@sattori/shared";
import type { AdminJobSummary, JobStatus } from "@sattori/shared";

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/**
 * `JobsTable` に張ったGSI。PK=status, SK=createdAt（`infra/lib/sattori-stack.ts`）。
 * `status`/`createdAt`は`putJob()`が必ず設定し、以降どの更新経路でも消えない既存属性
 * のため、GSI追加だけで既存レコードが自動的にインデックスへ載る(バックフィル不要)。
 */
export const STATUS_CREATED_AT_INDEX = "StatusCreatedAtIndex";

/**
 * `AdminJobSummary`が持つ属性のみを`ProjectionExpression`で取得する。
 * GSIのProjectionは`ALL`だが、通信量を抑えるためクエリ側でも絞る。
 */
const SUMMARY_PROJECTION =
  "jobId, game, #status, createdAt, updatedAt, email, #error, workerKind, instanceType, availabilityZone, progress, replayInfo";
const SUMMARY_EXPRESSION_ATTRIBUTE_NAMES = {
  // "status"はDynamoDBの予約語、"error"も同様に予約語のためプレースホルダが必要。
  "#status": "status",
  "#error": "error",
};

/** `GET /admin/jobs`のクエリパラメータをパースした結果。 */
export interface ListJobsParams {
  /** 指定が無ければ全ステータスを対象にする。 */
  status?: JobStatus;
  limit: number;
  /** 前ページの末尾から続ける場合のカーソル。無ければ先頭から。 */
  cursor?: JobsCursor;
}

/**
 * ページングカーソル。k-wayマージの再開位置は「マージ後のページ境界」ではなく
 * **status毎に最後に採用したアイテム**で表す（そのstatusのGSIクエリの
 * `ExclusiveStartKey`にそのまま使う）。
 *
 * 単一の(createdAt, jobId)を全ストリーム共通の境界として使い
 * `createdAt <= cursor`で絞り込む方式だと、カーソル自身や同一createdAtのアイテムが
 * `Limit`の枠を食い、そのストリームが上位limit件を返せなくなる。結果として
 * 「各ストリームが上位limit件を返している」というマージの前提が崩れ、ページ末尾が
 * 別ストリームの遥かに古いアイテムで埋まってカーソルが一気に過去へ飛ぶ
 * （＝間のジョブが一覧から丸ごと欠落する）。ストリーム毎の再開位置なら
 * 絞り込み・境界除外が一切不要になり、この破綻が原理的に起きない。
 */
export type JobsCursor = Partial<Record<JobStatus, JobsCursorEntry>>;

/** GSI(`StatusCreatedAtIndex`)の`ExclusiveStartKey`を組み立てるのに必要な値。 */
export interface JobsCursorEntry {
  createdAt: string;
  jobId: string;
}

/** クエリパラメータの`limit`文字列を範囲内の数値へクランプする。不正値は既定値。 */
export function normalizeLimit(raw: string | undefined): number {
  const parsed = raw !== undefined ? Number(raw) : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return ADMIN_JOB_LIST_DEFAULT_LIMIT;
  }
  return Math.min(Math.floor(parsed), ADMIN_JOB_LIST_MAX_LIMIT);
}

/**
 * 不透明カーソル文字列をエンコードする。中身（status毎の再開位置）はクライアントが
 * 解釈すべきではない実装詳細のため、base64url化して不透明に見せる。
 */
export function encodeCursor(cursor: JobsCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

/** `encodeCursor`の逆変換。不正な形式なら null。 */
export function decodeCursor(encoded: string): JobsCursor | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const cursor: JobsCursor = {};
  for (const [status, entry] of Object.entries(parsed)) {
    if (!(JOB_STATUSES as readonly string[]).includes(status)) {
      return null;
    }
    if (typeof entry !== "object" || entry === null) {
      return null;
    }
    const { createdAt, jobId } = entry as Record<string, unknown>;
    if (typeof createdAt !== "string" || typeof jobId !== "string" || jobId === "") {
      return null;
    }
    if (Number.isNaN(Date.parse(createdAt))) {
      return null;
    }
    cursor[status as JobStatus] = { createdAt, jobId };
  }
  return cursor;
}

/**
 * (createdAt, jobId)の降順比較。createdAtが同値の場合はjobIdでタイブレークする
 * （同一ミリ秒に複数ジョブが作成された場合でも順序を一意に定めるため）。
 */
function compareDesc(a: JobsCursorEntry, b: JobsCursorEntry): number {
  if (a.createdAt !== b.createdAt) {
    return a.createdAt < b.createdAt ? 1 : -1;
  }
  if (a.jobId === b.jobId) {
    return 0;
  }
  return a.jobId < b.jobId ? 1 : -1;
}

interface StatusQueryResult {
  items: AdminJobSummary[];
  /** DynamoDBがこのstatusについて未取得のアイテムを残しているか。 */
  hasMore: boolean;
}

/**
 * 指定ステータス1件分のGSIクエリを実行する。`entry`が渡された場合はそのアイテムの
 * 直後から再開する（`ExclusiveStartKey`。GSIクエリでは索引キー(status, createdAt)に
 * 加えてテーブルのPK(jobId)も要る）。
 *
 * `Limit`をあえて`limit + 1`にしているのは`hasMore`を正確にするため。DynamoDBは
 * `Limit`に達して打ち切った場合、実際には後続が無くても`LastEvaluatedKey`を返す。
 * 1件多く要求しておけば、`LastEvaluatedKey`が返る＝「limit+1件返した（＝ページ外に
 * 溢れるアイテムが実在する）」か「1MB制限で途中打ち切り（＝やはり後続が実在する）」
 * のどちらかに限定でき、空ページへ進む「次へ」ボタンが出なくなる。
 */
async function queryByStatus(
  table: string,
  status: JobStatus,
  limit: number,
  entry: JobsCursorEntry | undefined,
): Promise<StatusQueryResult> {
  const result = await client.send(
    new QueryCommand({
      TableName: table,
      IndexName: STATUS_CREATED_AT_INDEX,
      KeyConditionExpression: "#status = :status",
      ExpressionAttributeNames: SUMMARY_EXPRESSION_ATTRIBUTE_NAMES,
      ExpressionAttributeValues: { ":status": status },
      ...(entry
        ? { ExclusiveStartKey: { status, createdAt: entry.createdAt, jobId: entry.jobId } }
        : {}),
      ProjectionExpression: SUMMARY_PROJECTION,
      ScanIndexForward: false,
      Limit: limit + 1,
    }),
  );
  return {
    items: (result.Items as AdminJobSummary[] | undefined) ?? [],
    hasMore: result.LastEvaluatedKey !== undefined,
  };
}

export interface ListJobsResult {
  items: AdminJobSummary[];
  nextCursor: JobsCursor | null;
}

/**
 * ジョブ一覧を新しい順に取得する。GSI(`StatusCreatedAtIndex`)にソートキーが無い
 * （PKがstatusで固定）ため、status未指定時は`JOB_STATUSES`ぶん並列にQueryし、
 * createdAt降順でk-wayマージする。各ストリームが（自身の再開位置以降の）上位limit件を
 * 必ず返す以上、その和集合には全体の上位limit件が必ず含まれる。
 *
 * status遷移中のジョブが複数ストリームに現れうるため、マージ後にjobIdでdedupeする。
 * ページを跨いだ重複・欠落は管理画面の性質上許容する(`apps/api/README.md`参照)。
 */
export async function listJobs(table: string, params: ListJobsParams): Promise<ListJobsResult> {
  const statuses = params.status ? [params.status] : JOB_STATUSES;

  const perStatusResults = await Promise.all(
    statuses.map((status) => queryByStatus(table, status, params.limit, params.cursor?.[status])),
  );

  const merged = perStatusResults.flatMap((r) => r.items).sort((a, b) => compareDesc(a, b));
  // いずれかのstatusで未取得ぶんが残っていれば、それらは必ず取得済みアイテムより古い
  // （＝マージ後の順序でさらに後ろに来る）ため、ページ内件数がlimit以下でも続きがある。
  const anyStreamHasMore = perStatusResults.some((r) => r.hasMore);

  const seen = new Set<string>();
  const deduped: AdminJobSummary[] = [];
  for (const item of merged) {
    if (seen.has(item.jobId)) {
      continue;
    }
    seen.add(item.jobId);
    deduped.push(item);
  }

  const page = deduped.slice(0, params.limit);
  const hasMore = deduped.length > params.limit || anyStreamHasMore;

  // 次ページの再開位置は、このページで各statusから最後に採用したアイテム。pageは
  // createdAt降順なので、順に上書きすれば各statusの最古の採用アイテムが残る。
  // 1件も採用されなかったstatusは前回のカーソルを据え置く（そのstatusが返した
  // アイテムはページに載っていない＝まだ見せていないので、再開位置も進めない）。
  const nextCursor: JobsCursor = { ...params.cursor };
  for (const item of page) {
    nextCursor[item.status] = { createdAt: item.createdAt, jobId: item.jobId };
  }

  return { items: page, nextCursor: hasMore && page.length > 0 ? nextCursor : null };
}
