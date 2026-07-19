import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { StartJob } from "./StartJob.tsx";
import * as client from "../api/client.ts";

vi.mock("../api/client.ts", () => ({
  SattoriApiError: class extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
  startJob: vi.fn(),
}));

const mocked = vi.mocked(client);

describe("StartJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("マウント時に自動でstartJobを呼び、成功したらonStartedが発火する", async () => {
    mocked.startJob.mockResolvedValue({ jobId: "job-1", status: "queued" });
    const onStarted = vi.fn();

    render(<StartJob jobId="job-1" onStarted={onStarted} onReset={vi.fn()} />);

    expect(screen.getByText("録画を開始しています…")).toBeTruthy();
    expect(mocked.startJob).toHaveBeenCalledWith("job-1");
    await waitFor(() => expect(onStarted).toHaveBeenCalledWith("job-1"));
  });

  it("既に起動済みのジョブへの再アクセスも冪等に成功として扱う", async () => {
    mocked.startJob.mockResolvedValue({ jobId: "job-1", status: "recording" });
    const onStarted = vi.fn();

    render(<StartJob jobId="job-1" onStarted={onStarted} onReset={vi.fn()} />);

    await waitFor(() => expect(onStarted).toHaveBeenCalledWith("job-1"));
  });

  it("失敗時はエラーメッセージと再試行導線を表示する", async () => {
    mocked.startJob.mockRejectedValue(
      new client.SattoriApiError("job_expired", "受付期限が切れています"),
    );
    const onStarted = vi.fn();
    const onReset = vi.fn();

    render(<StartJob jobId="job-1" onStarted={onStarted} onReset={onReset} />);

    await waitFor(() => expect(screen.getByText("受付期限が切れています")).toBeTruthy());
    expect(onStarted).not.toHaveBeenCalled();

    screen.getByText("最初からやり直す").click();
    expect(onReset).toHaveBeenCalled();
  });
});
