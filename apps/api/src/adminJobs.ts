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
  "jobId, game, #status, createdAt, updatedAt, email, #error, instanceType, availabilityZone, progress, replayInfo";
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

export interface JobsCursor {
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
 * 不透明カーソル文字列をエンコードする。中身（createdAt|jobId）はクライアントが
 * 解釈すべきではない実装詳細のため、base64url化して不透明に見せる。
 */
export function encodeCursor(cursor: JobsCursor): string {
  const raw = `${cursor.createdAt}|${cursor.jobId}`;
  return Buffer.from(raw, "utf8").toString("base64url");
}

/** `encodeCursor`の逆変換。不正な形式なら null。 */
export function decodeCursor(encoded: string): JobsCursor | null {
  let raw: string;
  try {
    raw = Buffer.from(encoded, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const separatorIndex = raw.lastIndexOf("|");
  if (separatorIndex <= 0 || separatorIndex === raw.length - 1) {
    return null;
  }
  const createdAt = raw.slice(0, separatorIndex);
  const jobId = raw.slice(separatorIndex + 1);
  if (Number.isNaN(Date.parse(createdAt))) {
    return null;
  }
  return { createdAt, jobId };
}

/**
 * (createdAt, jobId)の降順比較。createdAtが同値の場合はjobIdでタイブレークする
 * （同一ミリ秒に複数ジョブが作成された場合でも順序を一意に定めるため）。
 */
function compareDesc(a: JobsCursor, b: JobsCursor): number {
  if (a.createdAt !== b.createdAt) {
    return a.createdAt < b.createdAt ? 1 : -1;
  }
  if (a.jobId === b.jobId) {
    return 0;
  }
  return a.jobId < b.jobId ? 1 : -1;
}

/**
 * 指定ステータス1件分のGSIクエリを実行する。`cursor`が渡された場合は
 * `createdAt <= cursor.createdAt`（カーソル自体を含む。同一createdAtの
 * 別アイテムを取りこぼさないため、マージ後に境界要素はcompareDescで除外する）
 * で絞り込んだ続きから取得する。
 */
interface StatusQueryResult {
  items: AdminJobSummary[];
  /** DynamoDBがこのstatusについて未取得のアイテムを残している(=LastEvaluatedKeyあり)か。 */
  hasMore: boolean;
}

async function queryByStatus(
  table: string,
  status: JobStatus,
  limit: number,
  cursor: JobsCursor | undefined,
): Promise<StatusQueryResult> {
  const result = await client.send(
    new QueryCommand({
      TableName: table,
      IndexName: STATUS_CREATED_AT_INDEX,
      KeyConditionExpression: cursor
        ? "#status = :status AND createdAt <= :cursorCreatedAt"
        : "#status = :status",
      ExpressionAttributeNames: SUMMARY_EXPRESSION_ATTRIBUTE_NAMES,
      ExpressionAttributeValues: {
        ":status": status,
        ...(cursor ? { ":cursorCreatedAt": cursor.createdAt } : {}),
      },
      ProjectionExpression: SUMMARY_PROJECTION,
      ScanIndexForward: false,
      Limit: limit,
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
 * createdAt降順でk-wayマージする。各ストリームが上位limit件を返している以上、
 * その和集合には全体の上位limit件が必ず含まれる。
 *
 * status遷移中のジョブが複数ストリームに現れうるため、マージ後にjobIdでdedupeする。
 * ページを跨いだ重複・欠落は管理画面の性質上許容する(`apps/api/README.md`参照)。
 */
export async function listJobs(table: string, params: ListJobsParams): Promise<ListJobsResult> {
  const statuses = params.status ? [params.status] : JOB_STATUSES;

  const perStatusResults = await Promise.all(
    statuses.map((status) => queryByStatus(table, status, params.limit, params.cursor)),
  );

  const merged = perStatusResults.flatMap((r) => r.items).sort((a, b) => compareDesc(a, b));
  // いずれかのstatusでLastEvaluatedKeyが返っていれば、その分は未取得のまま残っている
  // （必ず現在の取得済みアイテムより古い＝マージ後の順序でさらに後ろに来る）ため、
  // 「filtered.length <= limit」であってもページはまだ続く。
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

  // カーソル指定時、`createdAt <= cursor.createdAt`で取得しているためカーソル自体
  // (前ページ最後のアイテム)がまだ含まれている。カーソルより厳密に古い(=降順で後ろに
  // 来る)アイテムだけを残す。compareDesc(item, cursor) > 0 は「itemがcursorより古い」
  // ことを意味する(compareDescは降順ソート用の比較関数のため)。
  const filtered = params.cursor
    ? deduped.filter((item) => compareDesc(item, params.cursor!) > 0)
    : deduped;

  const page = filtered.slice(0, params.limit);
  const hasMore = filtered.length > params.limit || anyStreamHasMore;
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? { createdAt: last.createdAt, jobId: last.jobId } : null;

  return { items: page, nextCursor };
}
