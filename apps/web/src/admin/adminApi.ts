import type {
  AdminExecutionResponse,
  AdminJobDetailResponse,
  AdminJobListResponse,
  AdminLogsResponse,
  JobStatus,
} from "@sattori/shared";
import { request, SattoriApiError } from "../api/client.ts";

/**
 * API Gatewayのauthorizer拒否（401/403）を表す。`SattoriApiError`は認可拒否時、
 * このAPIの`ApiError`(code/message)形ではなくAPI Gateway自身の
 * `{"message":"Unauthorized"}`のような形式を返すため`code`では判別できず、
 * HTTPステータスで判定する。呼び出し元はこれを受けてログイン画面に戻す。
 */
export class AdminUnauthorizedError extends Error {}

async function adminRequest<T>(token: string, path: string): Promise<T> {
  try {
    return await request<T>(path, {
      headers: { authorization: `Bearer ${token}` },
    });
  } catch (err) {
    if (err instanceof SattoriApiError && (err.status === 401 || err.status === 403)) {
      throw new AdminUnauthorizedError(err.message);
    }
    throw err;
  }
}

export interface FetchAdminJobsParams {
  status?: JobStatus;
  cursor?: string;
  limit?: number;
}

export function fetchAdminJobs(
  token: string,
  params: FetchAdminJobsParams,
): Promise<AdminJobListResponse> {
  const query = new URLSearchParams();
  if (params.status) {
    query.set("status", params.status);
  }
  if (params.cursor) {
    query.set("cursor", params.cursor);
  }
  if (params.limit) {
    query.set("limit", String(params.limit));
  }
  const queryString = query.toString();
  return adminRequest<AdminJobListResponse>(
    token,
    `/admin/jobs${queryString ? `?${queryString}` : ""}`,
  );
}

export function fetchAdminJobDetail(token: string, jobId: string): Promise<AdminJobDetailResponse> {
  return adminRequest<AdminJobDetailResponse>(token, `/admin/jobs/${encodeURIComponent(jobId)}`);
}

export function fetchAdminExecution(token: string, jobId: string): Promise<AdminExecutionResponse> {
  return adminRequest<AdminExecutionResponse>(
    token,
    `/admin/jobs/${encodeURIComponent(jobId)}/execution`,
  );
}

export interface FetchAdminLogsParams {
  /** 続きから古いイベントを取得する場合に前回レスポンスの`nextBackwardToken`を渡す。 */
  cursor?: string;
  /** ログストリームが見つからない場合のコンソール出力フォールバック用。 */
  instanceId?: string | null;
}

export function fetchAdminLogs(
  token: string,
  jobId: string,
  params: FetchAdminLogsParams = {},
): Promise<AdminLogsResponse> {
  const query = new URLSearchParams();
  if (params.cursor) {
    query.set("cursor", params.cursor);
  }
  if (params.instanceId) {
    query.set("instanceId", params.instanceId);
  }
  const queryString = query.toString();
  return adminRequest<AdminLogsResponse>(
    token,
    `/admin/jobs/${encodeURIComponent(jobId)}/logs${queryString ? `?${queryString}` : ""}`,
  );
}
