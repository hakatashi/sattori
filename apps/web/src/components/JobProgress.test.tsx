import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { GetJobResponse, ReplayInfo } from "@sattori/shared";
import { JobProgressView } from "./JobProgress.tsx";

describe("JobProgressView の初回ロード中表示", () => {
  it("jobが未取得の間はステータス別の文言（pending/queued等）を表示しない", () => {
    render(<JobProgressView job={null} loadError={null} />);

    expect(screen.getByText("読み込み中…")).toBeTruthy();
    expect(screen.queryByText("録画の準備をしています")).toBeNull();
    expect(screen.queryByText("録画の順番を待っています")).toBeNull();
  });
});

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
    // API側(getJob.ts)が response-content-disposition クエリ付きで組み立てて返す
    // 想定のURL。ブラウザ標準のダウンロード機構を使わせるため、フロントは
    // このURLへの単純な<a>リンクを描画するだけでよい（filenameを自前で組み立てない）。
    downloadUrl: "https://media.example/original.mp4?response-content-disposition=attachment%3B...",
    downloadUrl720p: "https://media.example/720p.mp4?response-content-disposition=attachment%3B...",
    error: null,
    updatedAt: new Date().toISOString(),
    progress: null,
    previewImageUrl: null,
    replayInfo: REPLAY_INFO,
    ...overrides,
  };
}

describe("JobProgressView のダウンロード", () => {
  it("「動画をダウンロード」は720p版のダウンロードURLへのリンクになる", () => {
    render(<JobProgressView job={buildDoneJob()} loadError={null} />);

    const link = screen.getByText("動画をダウンロード") as HTMLAnchorElement;
    expect(link.tagName).toBe("A");
    expect(link.href).toBe(buildDoneJob().downloadUrl720p);
    expect(link.hasAttribute("download")).toBe(true);
  });

  it("「元の解像度でダウンロード」は元解像度版のダウンロードURLへのリンクになる", () => {
    render(<JobProgressView job={buildDoneJob()} loadError={null} />);

    const link = screen.getByText("元の解像度でダウンロード") as HTMLAnchorElement;
    expect(link.tagName).toBe("A");
    expect(link.href).toBe(buildDoneJob().downloadUrl);
    expect(link.hasAttribute("download")).toBe(true);
  });

  it("720p版が無ければ「動画をダウンロード」が元解像度版へフォールバックする", () => {
    render(
      <JobProgressView job={buildDoneJob({ downloadUrl720p: null })} loadError={null} />,
    );

    const link = screen.getByText("動画をダウンロード") as HTMLAnchorElement;
    expect(link.href).toBe(buildDoneJob().downloadUrl);
    expect(screen.queryByText("元の解像度でダウンロード")).toBeNull();
  });
});
