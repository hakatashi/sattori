import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { AdminJobSummary } from "@sattori/shared";
import { JobListPage } from "./JobListPage.tsx";
import { AdminAuthContext } from "./AdminAuthContext.ts";
import * as adminApi from "./adminApi.ts";

vi.mock("./adminApi.ts", () => ({
  AdminUnauthorizedError: class extends Error {},
  fetchAdminJobs: vi.fn(),
}));

const mocked = vi.mocked(adminApi);

function summary(jobId: string): AdminJobSummary {
  return {
    jobId,
    game: "th11",
    status: "done",
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
    email: "user@example.com",
    error: null,
    workerKind: "ec2",
    instanceType: null,
    availabilityZone: null,
    progress: null,
    replayInfo: null,
  };
}

function renderJobListPage() {
  return render(
    <MemoryRouter initialEntries={["/admin"]}>
      <AdminAuthContext.Provider value={{ token: "token", onUnauthorized: vi.fn() }}>
        <JobListPage />
      </AdminAuthContext.Provider>
    </MemoryRouter>,
  );
}

describe("JobListPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("取得したジョブを行として描画する", async () => {
    mocked.fetchAdminJobs.mockResolvedValue({ items: [summary("job-1")], nextCursor: null });
    renderJobListPage();

    await waitFor(() => expect(screen.getByText("job-1")).toBeTruthy());
    expect(screen.getByText("user@example.com")).toBeTruthy();
  });

  it("statusセレクトを変更するとその値付きでfetchAdminJobsが呼ばれる", async () => {
    mocked.fetchAdminJobs.mockResolvedValue({ items: [], nextCursor: null });
    renderJobListPage();

    await waitFor(() => expect(mocked.fetchAdminJobs).toHaveBeenCalledWith("token", { status: undefined, cursor: undefined }));

    const select = screen.getByRole("combobox");
    fireEvent.change(select, { target: { value: "failed" } });

    await waitFor(() =>
      expect(mocked.fetchAdminJobs).toHaveBeenCalledWith("token", { status: "failed", cursor: undefined }),
    );
  });

  it("nextCursorがある場合のみ「次へ」が有効になる", async () => {
    mocked.fetchAdminJobs.mockResolvedValue({ items: [summary("job-1")], nextCursor: "abc" });
    renderJobListPage();

    await waitFor(() => expect(screen.getByText("次へ")).toBeTruthy());
    const nextButton = screen.getByText("次へ") as HTMLButtonElement;
    expect(nextButton.disabled).toBe(false);

    const prevButton = screen.getByText("前へ") as HTMLButtonElement;
    expect(prevButton.disabled).toBe(true);
  });

  it("nextCursorが無ければ「次へ」が無効になる", async () => {
    mocked.fetchAdminJobs.mockResolvedValue({ items: [summary("job-1")], nextCursor: null });
    renderJobListPage();

    await waitFor(() => expect(screen.getByText("次へ")).toBeTruthy());
    const nextButton = screen.getByText("次へ") as HTMLButtonElement;
    expect(nextButton.disabled).toBe(true);
  });
});
