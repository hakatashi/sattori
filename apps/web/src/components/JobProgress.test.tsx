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

  it("「変換前の動画をダウンロード」は元解像度版のダウンロードURLへのリンクになる", () => {
    render(<JobProgressView job={buildDoneJob()} loadError={null} />);

    const link = screen.getByText("変換前の動画をダウンロード") as HTMLAnchorElement;
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
    expect(screen.queryByText("変換前の動画をダウンロード")).toBeNull();
  });
});

function buildRecordingJob(overrides: Partial<GetJobResponse> = {}): GetJobResponse {
  return {
    jobId: "job-1",
    game: "th11",
    status: "recording",
    downloadUrl: null,
    downloadUrl720p: null,
    error: null,
    updatedAt: new Date().toISOString(),
    progress: 100,
    previewImageUrl: null,
    replayInfo: REPLAY_INFO,
    ...overrides,
  };
}

describe("JobProgressView の全体進捗バー", () => {
  it("recording中は全体進捗バーと「残り約○分」が表示される", () => {
    render(<JobProgressView job={buildRecordingJob()} loadError={null} />);

    const bar = screen.getByRole("progressbar", { name: "全体の進捗" });
    expect(bar).toBeTruthy();
    expect(screen.getByText(/残り約\d+分/)).toBeTruthy();
  });

  it("replayInfoのestimatedDurationSecondsが無い場合は「残り約」テキストが出ない", () => {
    render(
      <JobProgressView job={buildRecordingJob({ replayInfo: null })} loadError={null} />,
    );

    expect(screen.getByRole("progressbar", { name: "全体の進捗" })).toBeTruthy();
    expect(screen.queryByText(/残り約\d+分/)).toBeNull();
  });

  it("failedでは全体進捗バーが表示されない", () => {
    render(
      <JobProgressView
        job={buildRecordingJob({ status: "failed", error: "失敗しました" })}
        loadError={null}
      />,
    );

    expect(screen.queryByRole("progressbar", { name: "全体の進捗" })).toBeNull();
  });

  it("doneでは全体進捗バーが100%表示になる", () => {
    render(<JobProgressView job={buildDoneJob()} loadError={null} />);

    const bar = screen.getByRole("progressbar", { name: "全体の進捗" });
    expect(bar.getAttribute("aria-valuenow")).toBe("100");
    expect(screen.getByText("100%")).toBeTruthy();
  });
});
