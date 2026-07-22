import type {
  ApiError,
  CreateUploadRequest,
  CreateUploadResponse,
  GetJobResponse,
  ParseReplayRequest,
  ParseReplayResponse,
  RecordingOptions,
  ReplayInfo,
  RequestMagicLinkRequest,
  RequestMagicLinkResponse,
  StartJobResponse,
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

/** アップロード済みリプレイを解析し、ページAのプレビューに使う ReplayInfo を取得する。 */
export function parseReplay(replayKey: string): Promise<ParseReplayResponse> {
  const req: ParseReplayRequest = { replayKey };
  return request<ParseReplayResponse>("/replays/parse", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

/** マジックリンクメールの送信を要求する（ページAの「次のステップ」）。 */
export function requestMagicLink(
  replayKey: string,
  options: RecordingOptions,
  email: string,
  replayInfo?: ReplayInfo | null,
): Promise<RequestMagicLinkResponse> {
  const req: RequestMagicLinkRequest = {
    replayKey,
    options,
    email,
    game: replayInfo?.game,
    estimatedDurationSeconds: replayInfo?.estimatedDurationSeconds,
    replayInfo,
  };
  return request<RequestMagicLinkResponse>("/magic-links", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

/**
 * ジョブページ（メールのリンク先）へのアクセスで録画を起動する。jobIdのみで認可する
 * （tokenは廃止済み。jobId自体がメールを確認しないと分からない秘密値。Issue #9）。
 * 起動済みの場合も冪等に現在の状態を返す。
 */
export function startJob(jobId: string): Promise<StartJobResponse> {
  return request<StartJobResponse>(`/jobs/${encodeURIComponent(jobId)}/start`, {
    method: "POST",
  });
}

/** ジョブの現在状態を取得する。 */
export function getJob(jobId: string): Promise<GetJobResponse> {
  return request<GetJobResponse>(`/jobs/${encodeURIComponent(jobId)}`);
}
