import type {
  ApiError,
  CreateUploadRequest,
  CreateUploadResponse,
  GetJobResponse,
  GetWorkerAvailabilityResponse,
  RecordingOptions,
  ReplayInfo,
  RequestMagicLinkRequest,
  RequestMagicLinkResponse,
  StartJobResponse,
  SupportedLanguage,
} from "@sattori/shared";

const API_BASE = import.meta.env.VITE_API_BASE ?? "/api";

export class SattoriApiError extends Error {
  readonly code: string;
  /**
   * HTTPステータスコード。管理画面(`src/admin/`)がAPI Gatewayの認可拒否(401/403)を
   * 判別するために参照する。authorizerの拒否レスポンスは`{"message":"Unauthorized"}`
   * のような形式で、このAPIの`ApiError`(code/message)形ではないため`code`では
   * 判別できず、ステータスコードで判定する必要がある(Issue #51)。
   */
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "SattoriApiError";
    this.code = code;
    this.status = status;
  }
}

/**
 * `apps/web/src/admin/`（管理画面）が`Authorization`ヘッダー付きで叩けるよう export する。
 * fetchとエラー整形の実装を二重化しないための共有。
 */
export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as ApiError | null;
    throw new SattoriApiError(
      body?.code ?? "http_error",
      body?.message ?? `リクエストに失敗しました (${res.status})`,
      res.status,
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
    throw new SattoriApiError("upload_failed", "リプレイファイルのアップロードに失敗しました", res.status);
  }
}

/** マジックリンクメールの送信を要求する（ページAの「次のステップ」）。 */
export function requestMagicLink(
  replayKey: string,
  options: RecordingOptions,
  email: string,
  language: SupportedLanguage,
  replayInfo?: ReplayInfo | null,
): Promise<RequestMagicLinkResponse> {
  const req: RequestMagicLinkRequest = {
    replayKey,
    options,
    email,
    game: replayInfo?.game,
    estimatedDurationSeconds: replayInfo?.estimatedDurationSeconds,
    replayInfo,
    language,
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

/**
 * 常駐ワーカー（自宅ワーカー、Issue #49）の空き状況を取得する。ページAが
 * 「低速録画」（Issue #68）を選べるかの判定にだけ使う。
 */
export function getWorkerAvailability(): Promise<GetWorkerAvailabilityResponse> {
  return request<GetWorkerAvailabilityResponse>("/worker-availability");
}
