import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { JOB_STATUSES, type AdminJobListResponse, type JobStatus } from "@sattori/shared";
import { decodeCursor, encodeCursor, listJobs, normalizeLimit } from "../../adminJobs.js";
import { loadConfig } from "../../config.js";
import { error, json } from "../../http.js";

function isJobStatus(value: string): value is JobStatus {
  return (JOB_STATUSES as readonly string[]).includes(value);
}

/**
 * GET /admin/jobs?status=&limit=&cursor=
 * ジョブ一覧を新しい順に返す（管理画面。Issue #51）。認可はAPI Gateway側の
 * Lambda Authorizer(`handlers/admin/authorizer.ts`)が担うため、ここでは行わない。
 */
export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const config = loadConfig();
  const query = event.queryStringParameters ?? {};

  const statusParam = query.status;
  if (statusParam !== undefined && !isJobStatus(statusParam)) {
    return error(400, "invalid_status", `statusが不正です: ${statusParam}`);
  }

  let cursor;
  if (query.cursor !== undefined) {
    cursor = decodeCursor(query.cursor);
    if (!cursor) {
      return error(400, "invalid_cursor", "cursorが不正です");
    }
  }

  const result = await listJobs(config.jobsTable, {
    status: statusParam,
    limit: normalizeLimit(query.limit),
    cursor,
  });

  const response: AdminJobListResponse = {
    items: result.items,
    nextCursor: result.nextCursor ? encodeCursor(result.nextCursor) : null,
  };
  return json(200, response);
};
