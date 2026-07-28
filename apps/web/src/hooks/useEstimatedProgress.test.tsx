import { describe, expect, it, afterEach, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { GetJobResponse, ReplayInfo } from "@sattori/shared";
import { useEstimatedProgress } from "./useEstimatedProgress.ts";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
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
  estimatedDurationSeconds: 800,
};

function buildJob(overrides: Partial<GetJobResponse> = {}): GetJobResponse {
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

function Probe({ job }: { job: GetJobResponse | null }) {
  const progress = useEstimatedProgress(job);
  return <span data-testid="progress">{progress === null ? "null" : progress.toFixed(2)}</span>;
}

describe("useEstimatedProgress", () => {
  it("録画フェーズでは実時間の経過とともに1倍速で進捗が伸びる", () => {
    vi.useFakeTimers();
    const now = new Date("2026-01-01T00:00:00.000Z");
    vi.setSystemTime(now);
    const job = buildJob({ status: "recording", progress: 100, updatedAt: now.toISOString() });

    render(<Probe job={job} />);
    expect(screen.getByTestId("progress").textContent).toBe("100.00");

    act(() => {
      vi.advanceTimersByTime(4000);
    });
    const value = Number(screen.getByTestId("progress").textContent);
    expect(value).toBeGreaterThan(103);
    expect(value).toBeLessThanOrEqual(104.5);
  });

  it("変換フェーズでは録画フェーズより速く進捗が伸びる", () => {
    vi.useFakeTimers();
    const now = new Date("2026-01-01T00:00:00.000Z");
    vi.setSystemTime(now);
    const job = buildJob({ status: "converting", progress: 100, updatedAt: now.toISOString() });

    render(<Probe job={job} />);

    act(() => {
      vi.advanceTimersByTime(4000);
    });
    const value = Number(screen.getByTestId("progress").textContent);
    expect(value).toBeGreaterThan(115);
  });

  it("estimatedDurationSecondsを超えて伸びない", () => {
    vi.useFakeTimers();
    const now = new Date("2026-01-01T00:00:00.000Z");
    vi.setSystemTime(now);
    const job = buildJob({ status: "converting", progress: 790, updatedAt: now.toISOString() });

    render(<Probe job={job} />);

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByTestId("progress").textContent).toBe("800.00");
  });

  it("新しいジョブ情報が届くとサーバー値へ同期する（推定値が先行していても巻き戻る）", () => {
    vi.useFakeTimers();
    const now = new Date("2026-01-01T00:00:00.000Z");
    vi.setSystemTime(now);
    const job1 = buildJob({ status: "recording", progress: 100, updatedAt: now.toISOString() });

    const { rerender } = render(<Probe job={job1} />);

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(Number(screen.getByTestId("progress").textContent)).toBeGreaterThan(102);

    const laterNow = new Date(now.getTime() + 3000);
    vi.setSystemTime(laterNow);
    const job2 = buildJob({ status: "recording", progress: 101, updatedAt: laterNow.toISOString() });
    rerender(<Probe job={job2} />);

    expect(screen.getByTestId("progress").textContent).toBe("101.00");
  });

  it("progressがnullなら推定せずnullを返す", () => {
    const job = buildJob({ status: "queued", progress: null });
    render(<Probe job={job} />);
    expect(screen.getByTestId("progress").textContent).toBe("null");
  });
});
