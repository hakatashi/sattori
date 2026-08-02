import type {
  AdminCostSummaryResponse,
  AdminExecutionResponse,
  AdminJobDetailResponse,
  AdminJobListResponse,
  AdminLogsResponse,
  AdminRetryJobResponse,
  AdminStopJobResponse,
  CostGranularity,
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

async function adminRequest<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  try {
    return await request<T>(path, {
      ...init,
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

export interface FetchAdminCostsParams {
  granularity: CostGranularity;
  /** 返すバケット数（新しい順）。省略時はAPI側の既定値。 */
  limit?: number;
}

/**
 * コスト推定の期間集計（Issue #60）。返るのは**請求額ではなく推定値**で、
 * 単価と算出モデルは`@sattori/shared`の`cost.ts`にある（ジョブ詳細のコスト
 * パネルと同じ実装を共有している）。
 */
export function fetchAdminCosts(
  token: string,
  params: FetchAdminCostsParams,
): Promise<AdminCostSummaryResponse> {
  const query = new URLSearchParams({ granularity: params.granularity });
  if (params.limit) {
    query.set("limit", String(params.limit));
  }
  return adminRequest<AdminCostSummaryResponse>(token, `/admin/costs?${query.toString()}`);
}

/**
 * 暴走ジョブの緊急停止（Issue #59）。Step Functions実行の停止 → EC2インスタンスの
 * terminate → ジョブを`failed`に確定、までをAPI側が一括で行う破壊的操作のため、
 * 呼び出し側は必ず確認ダイアログを挟むこと。
 */
export function stopAdminJob(token: string, jobId: string): Promise<AdminStopJobResponse> {
  return adminRequest<AdminStopJobResponse>(
    token,
    `/admin/jobs/${encodeURIComponent(jobId)}/stop`,
    { method: "POST" },
  );
}

/**
 * 失敗ジョブの再実行（Issue #59）。元ジョブは変更せず、**新しいjobIdのジョブ**を
 * 複製して起動する（レスポンスの`jobId`が新しい方）。EC2を起動する＝課金が発生する
 * 操作のため、呼び出し側は必ず確認ダイアログを挟むこと。
 */
export function retryAdminJob(token: string, jobId: string): Promise<AdminRetryJobResponse> {
  return adminRequest<AdminRetryJobResponse>(
    token,
    `/admin/jobs/${encodeURIComponent(jobId)}/retry`,
    { method: "POST" },
  );
}
