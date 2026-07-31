import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { AdminExecutionResponse, AdminJobDetailResponse, JobRecord } from "@sattori/shared";
import { JobDetailPage } from "./JobDetailPage.tsx";
import { AdminAuthContext } from "./AdminAuthContext.ts";
import * as adminApi from "./adminApi.ts";

vi.mock("./adminApi.ts", () => ({
  AdminUnauthorizedError: class extends Error {},
  fetchAdminJobDetail: vi.fn(),
  fetchAdminExecution: vi.fn(),
}));

const mocked = vi.mocked(adminApi);

const job: JobRecord = {
  jobId: "job-1",
  game: "th11",
  replayKey: "replays/abc.rpy",
  status: "recording",
  options: { watermark: true },
  outputPath: "videos/job-1.mp4",
  outputPath720p: null,
  error: null,
  createdAt: "2026-07-30T00:00:00.000Z",
  updatedAt: "2026-07-30T00:00:00.000Z",
  doneAt: null,
  email: "user@example.com",
  instanceId: "i-1234",
  instanceType: "c7i.2xlarge",
  availabilityZone: "us-east-1a",
  estimatedDurationSeconds: 900,
  progress: 120,
  previewImagePath: "progress/job-1/1234.jpg",
  replayInfo: null,
  pendingExpiresAt: null,
  language: "ja",
};

const detailResponse: AdminJobDetailResponse = {
  job,
  downloads: {
    replayUrl: "https://up-bucket.s3.amazonaws.com/replays/abc.rpy?sig=1",
    videoUrl: "https://cdn.example.net/videos/job-1.mp4",
    video720pUrl: null,
    previewImageUrl: "https://cdn.example.net/progress/job-1/1234.jpg",
  },
};

const executionResponse: AdminExecutionResponse = {
  execution: null,
  events: [],
  eventsNextToken: null,
};

function renderJobDetailPage() {
  return render(
    <MemoryRouter initialEntries={["/admin/jobs/job-1"]}>
      <AdminAuthContext.Provider value={{ token: "token", onUnauthorized: vi.fn() }}>
        <Routes>
          <Route path="/admin/jobs/:jobId" element={<JobDetailPage />} />
        </Routes>
      </AdminAuthContext.Provider>
    </MemoryRouter>,
  );
}

describe("JobDetailPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked.fetchAdminExecution.mockResolvedValue(executionResponse);
  });

  it("JobRecordの各フィールド(instanceId/instanceType/AZ/email/progress)を描画する", async () => {
    mocked.fetchAdminJobDetail.mockResolvedValue(detailResponse);
    renderJobDetailPage();

    await waitFor(() => expect(screen.getByText("i-1234")).toBeTruthy());
    expect(screen.getByText("c7i.2xlarge")).toBeTruthy();
    expect(screen.getByText("us-east-1a")).toBeTruthy();
    expect(screen.getByText("user@example.com")).toBeTruthy();
    expect(screen.getByText("120")).toBeTruthy();
  });

  it("ダウンロードリンクのhrefが設定される", async () => {
    mocked.fetchAdminJobDetail.mockResolvedValue(detailResponse);
    renderJobDetailPage();

    await waitFor(() => expect(screen.getByText("動画（オリジナル解像度）")).toBeTruthy());
    const link = screen.getByText("動画（オリジナル解像度）") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("https://cdn.example.net/videos/job-1.mp4");

    expect(screen.getByText("動画（720p） — 未生成")).toBeTruthy();
  });

  it("execution: nullのとき「実行が見つかりません」を表示する", async () => {
    mocked.fetchAdminJobDetail.mockResolvedValue(detailResponse);
    renderJobDetailPage();

    await waitFor(() =>
      expect(
        screen.getByText(
          "実行が見つかりません（起動前のジョブ、または実行履歴の保持期間(90日)を過ぎている可能性があります）。",
        ),
      ).toBeTruthy(),
    );
  });

  it("doneAtが設定されたジョブはdoneAtフィールドとダウンロード期限を表示する", async () => {
    const doneJob: JobRecord = { ...job, status: "done", doneAt: "2026-07-30T00:10:00.000Z" };
    mocked.fetchAdminJobDetail.mockResolvedValue({ ...detailResponse, job: doneJob });
    renderJobDetailPage();

    await waitFor(() => expect(screen.getByText(new Date(doneJob.doneAt as string).toLocaleString("ja-JP"))).toBeTruthy());
    // ダウンロード期限 = doneAt + OUTPUT_RETENTION_DAYS(7日) は未来のためexpired表示ではない。
    expect(screen.getByText(/^ダウンロード期限: /)).toBeTruthy();
  });

  it("doneAtが未設定のジョブはdoneAtフィールドに「-」を表示し、ダウンロード期限は表示しない", async () => {
    mocked.fetchAdminJobDetail.mockResolvedValue(detailResponse);
    renderJobDetailPage();

    await waitFor(() => expect(screen.getByText("i-1234")).toBeTruthy());
    expect(screen.queryByText(/^ダウンロード期限: /)).toBeNull();
    expect(screen.queryByText(/出力バケットの保持期間/)).toBeNull();
  });
});
