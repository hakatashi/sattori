import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import type { GetJobResponse, ReplayInfo } from "@sattori/shared";
import { JobProgressView } from "./JobProgress.tsx";
import * as downloadFileModule from "../lib/downloadFile.ts";

describe("JobProgressView の初回ロード中表示", () => {
  it("jobが未取得の間はステータス別の文言（pending/queued等）を表示しない", () => {
    render(<JobProgressView job={null} loadError={null} />);

    expect(screen.getByText("読み込み中…")).toBeTruthy();
    expect(screen.queryByText("録画の準備をしています")).toBeNull();
    expect(screen.queryByText("録画の順番を待っています")).toBeNull();
  });
});

vi.mock("../lib/downloadFile.ts", () => ({
  downloadFile: vi.fn(),
}));

const mockedDownloadFile = vi.mocked(downloadFileModule);

const REPLAY_INFO: ReplayInfo = {
  game: "th11",
  player: "koyi",
  date: "01/18",
  character: "霊夢A",
  difficulty: "Lunatic",
  stage: null,
  score: 442469780,
  cleared: true,
  estimatedDurationSeconds: 847,
};

function buildDoneJob(overrides: Partial<GetJobResponse> = {}): GetJobResponse {
  return {
    jobId: "job-1",
    game: "th11",
    status: "done",
    downloadUrl: "https://media.example/original.mp4",
    downloadUrl720p: "https://media.example/720p.mp4",
    error: null,
    updatedAt: new Date().toISOString(),
    progress: null,
    previewImageUrl: null,
    replayInfo: REPLAY_INFO,
    ...overrides,
  };
}

describe("JobProgressView のダウンロード", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("「動画をダウンロード」クリックで720p版をファイル名付きでダウンロードする", async () => {
    mockedDownloadFile.downloadFile.mockResolvedValue();
    render(<JobProgressView job={buildDoneJob()} loadError={null} />);

    screen.getByText("動画をダウンロード").click();

    await waitFor(() =>
      expect(mockedDownloadFile.downloadFile).toHaveBeenCalledWith(
        "https://media.example/720p.mp4",
        "東方地霊殿 Lunatic 霊夢A 442,469,780 (プレイヤー koyi) #TouhouSattori.mp4",
      ),
    );
  });

  it("「元の解像度でダウンロード」クリックで区別できるファイル名を使う", async () => {
    mockedDownloadFile.downloadFile.mockResolvedValue();
    render(<JobProgressView job={buildDoneJob()} loadError={null} />);

    screen.getByText("元の解像度でダウンロード").click();

    await waitFor(() =>
      expect(mockedDownloadFile.downloadFile).toHaveBeenCalledWith(
        "https://media.example/original.mp4",
        "東方地霊殿 Lunatic 霊夢A 442,469,780 (プレイヤー koyi) #raw #TouhouSattori.mp4",
      ),
    );
  });

  it("ダウンロード失敗時はエラーメッセージを表示する", async () => {
    mockedDownloadFile.downloadFile.mockRejectedValue(new Error("network error"));
    render(<JobProgressView job={buildDoneJob()} loadError={null} />);

    screen.getByText("動画をダウンロード").click();

    await waitFor(() =>
      expect(screen.getByText("ダウンロードに失敗しました。もう一度お試しください。")).toBeTruthy(),
    );
  });
});
