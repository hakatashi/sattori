import type {
  ApiError,
  CreateJobRequest,
  CreateJobResponse,
  CreateUploadRequest,
  CreateUploadResponse,
  GetJobResponse,
  RecordingOptions,
} from "@sattori/shared";

const API_BASE = import.meta.env.VITE_API_BASE ?? "/api";

export class SattoriApiError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "SattoriApiError";
    this.code = code;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as ApiError | null;
    throw new SattoriApiError(
      body?.code ?? "http_error",
      body?.message ?? `リクエストに失敗しました (${res.status})`,
    );
  }
  return (await res.json()) as T;
}

/** 署名付きアップロードURLを取得する。 */
export function createUpload(req: CreateUploadRequest): Promise<CreateUploadResponse> {
  return request<CreateUploadResponse>("/uploads", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

/** ブラウザから S3 へ .rpy を直接 PUT する。 */
export async function uploadReplay(uploadUrl: string, file: File): Promise<void> {
  const res = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "content-type": "application/octet-stream" },
    body: file,
  });
  if (!res.ok) {
    throw new SattoriApiError("upload_failed", "リプレイファイルのアップロードに失敗しました");
  }
}

/** 録画ジョブを起動する。 */
export function createJob(replayKey: string, options: RecordingOptions): Promise<CreateJobResponse> {
  const req: CreateJobRequest = { replayKey, options };
  return request<CreateJobResponse>("/jobs", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

/** ジョブの現在状態を取得する。 */
export function getJob(jobId: string): Promise<GetJobResponse> {
  return request<GetJobResponse>(`/jobs/${encodeURIComponent(jobId)}`);
}
