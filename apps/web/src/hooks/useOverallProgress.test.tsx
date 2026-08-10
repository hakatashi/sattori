import { describe, expect, it, afterEach, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { GetJobResponse, ReplayInfo } from "@sattori/shared";
import { useOverallProgress } from "./useOverallProgress.ts";
import { computePhaseBudgets, LAUNCHING_BUDGET_SECONDS, OVERALL_PROGRESS_CAP_PERCENT } from "./jobProgressBudget.ts";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const REPLAY_INFO: ReplayInfo = {
  game: "th11",
  player: "koyi",
  date: "01/18",
  character: "霊夢A",
  characterNameJa: null,
  characterNameEn: null,
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
    downloadExpiresAt: null,
    error: null,
    updatedAt: new Date().toISOString(),
    progress: 100,
    previewVideoUrl: null,
    previewImageUrl: null,
    replayInfo: REPLAY_INFO,
    slowMotion: false,
    ...overrides,
  };
}

function Probe({ job, phaseProgressSeconds }: { job: GetJobResponse | null; phaseProgressSeconds: number | null }) {
  const overall = useOverallProgress(job, phaseProgressSeconds);
  return (
    <div>
      <span data-testid="percent">{overall.percent.toFixed(1)}</span>
      <span data-testid="remaining">{overall.remainingMinutes === null ? "null" : overall.remainingMinutes}</span>
      <span data-testid="retry">{String(overall.retrySuspected)}</span>
    </div>
  );
}

describe("useOverallProgress", () => {
  it("launching中、経過時間に応じてpercentが伸びる", () => {
    vi.useFakeTimers();
    const now = new Date("2026-01-01T00:00:00.000Z");
    vi.setSystemTime(now);
    const job = buildJob({ status: "launching", progress: null, updatedAt: now.toISOString() });

    render(<Probe job={job} phaseProgressSeconds={null} />);
    expect(screen.getByTestId("percent").textContent).toBe("0.0");

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    const value = Number(screen.getByTestId("percent").textContent);
    const totalBudget = computePhaseBudgets(REPLAY_INFO.estimatedDurationSeconds).total;
    expect(value).toBeGreaterThan(0);
    expect(value).toBeCloseTo((60 / totalBudget) * 100, 0);
  });

  it("done到達時はpercentが100固定になる", () => {
    const job = buildJob({ status: "done", progress: null });
    render(<Probe job={job} phaseProgressSeconds={null} />);
    expect(screen.getByTestId("percent").textContent).toBe("100.0");
    expect(screen.getByTestId("remaining").textContent).toBe("null");
  });

  it("estimatedDurationSecondsがnullのジョブではremainingMinutesが常にnull", () => {
    const job = buildJob({ status: "recording", progress: 100, replayInfo: null });
    render(<Probe job={job} phaseProgressSeconds={100} />);
    expect(screen.getByTestId("remaining").textContent).toBe("null");
  });

  it("recordingからlaunchingへステータスが後退するとretrySuspectedがtrueになり、以後remainingMinutesが常にnullになる", () => {
    vi.useFakeTimers();
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    vi.setSystemTime(t0);
    const job1 = buildJob({ status: "recording", progress: 100, updatedAt: t0.toISOString() });

    const { rerender } = render(<Probe job={job1} phaseProgressSeconds={100} />);
    expect(screen.getByTestId("retry").textContent).toBe("false");
    expect(screen.getByTestId("remaining").textContent).not.toBe("null");

    // Step Functionsのリトライ: 3分後にstatusがlaunchingへ後退する(handleFailureはstatusを
    // 巻き戻さないため、DynamoDB上のstatusはrecordingのまま残った後に突然launchingへ戻る)。
    const t1 = new Date(t0.getTime() + 3 * 60_000);
    vi.setSystemTime(t1);
    const job2 = buildJob({ status: "launching", progress: null, updatedAt: t1.toISOString() });
    rerender(<Probe job={job2} phaseProgressSeconds={null} />);

    expect(screen.getByTestId("retry").textContent).toBe("true");
    expect(screen.getByTestId("remaining").textContent).toBe("null");

    // 後退後、通常通りlaunching→recordingへ進んでもsticky(true)のまま維持される。
    const t2 = new Date(t1.getTime() + 10_000);
    vi.setSystemTime(t2);
    const job3 = buildJob({ status: "recording", progress: 5, updatedAt: t2.toISOString() });
    rerender(<Probe job={job3} phaseProgressSeconds={5} />);
    expect(screen.getByTestId("retry").textContent).toBe("true");
    expect(screen.getByTestId("remaining").textContent).toBe("null");
  });

  it("同一フェーズにバジェットの1.5倍を超えて留まり続けるとretrySuspectedがtrueになる", () => {
    vi.useFakeTimers();
    const now = new Date("2026-01-01T00:00:00.000Z");
    vi.setSystemTime(now);
    const job = buildJob({ status: "launching", progress: null, updatedAt: now.toISOString() });

    const { rerender } = render(<Probe job={job} phaseProgressSeconds={null} />);
    expect(screen.getByTestId("retry").textContent).toBe("false");

    act(() => {
      vi.advanceTimersByTime(LAUNCHING_BUDGET_SECONDS * 1.6 * 1000);
    });
    // ポーリング結果としてjobオブジェクト自体は変わらないまま経過時間だけが伸びるケース
    rerender(<Probe job={job} phaseProgressSeconds={null} />);
    expect(screen.getByTestId("retry").textContent).toBe("true");
  });

  it("converting中は実際の変換進捗率に応じて全体percentが伸びる(悲観バジェットで早期に頭打ちにならない)", () => {
    const totalBudget = computePhaseBudgets(REPLAY_INFO.estimatedDurationSeconds).total;
    // 800秒中400秒(50%)変換済み。悲観バジェット換算(800/3≈266.67秒)に按分されるため、
    // 99%キャップより明確に低い値になるはず(旧実装ではphaseProgressSecondsをそのまま
    // budgets.convertingとminしていたため、この時点で早くも100%相当になり99%キャップに
    // 張り付いていた)。
    const job = buildJob({ status: "converting", progress: 400, updatedAt: new Date().toISOString() });
    render(<Probe job={job} phaseProgressSeconds={400} />);
    const value = Number(screen.getByTestId("percent").textContent);
    const expected = ((LAUNCHING_BUDGET_SECONDS + 800 + 0.5 * (800 / 3)) / totalBudget) * 100;
    expect(value).toBeCloseTo(expected, 0);
    expect(value).toBeLessThan(OVERALL_PROGRESS_CAP_PERCENT);
  });

  it("converting完了間際では全体percentが99%キャップに達する", () => {
    const job = buildJob({ status: "converting", progress: 799, updatedAt: new Date().toISOString() });
    render(<Probe job={job} phaseProgressSeconds={799} />);
    const value = Number(screen.getByTestId("percent").textContent);
    expect(value).toBeCloseTo(OVERALL_PROGRESS_CAP_PERCENT, 0);
  });

  it("converting中に実進捗が進んでいるだけではretrySuspectedにならない(進捗値とwall-clock経過時間の単位混同の回帰防止)", () => {
    // 変換済み700/800秒(87.5%)は、旧実装のバジェット比較(悲観バジェット266.67秒の1.5倍=400秒)
    // では超過扱いになってしまっていたが、convertingフェーズに入ってからの実経過時間はまだ
    // ごくわずかなので、誤ってリトライ疑いにならないことを確認する。
    const job = buildJob({ status: "converting", progress: 700, updatedAt: new Date().toISOString() });
    render(<Probe job={job} phaseProgressSeconds={700} />);
    expect(screen.getByTestId("retry").textContent).toBe("false");
  });

  it("failedはSTATUS_STEP後退検知の対象から除外される", () => {
    vi.useFakeTimers();
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    vi.setSystemTime(t0);
    const job1 = buildJob({ status: "converting", progress: 700, updatedAt: t0.toISOString() });
    const { rerender } = render(<Probe job={job1} phaseProgressSeconds={700} />);

    const t1 = new Date(t0.getTime() + 1000);
    vi.setSystemTime(t1);
    const job2 = buildJob({ status: "failed", progress: 700, updatedAt: t1.toISOString() });
    rerender(<Probe job={job2} phaseProgressSeconds={700} />);
    expect(screen.getByTestId("retry").textContent).toBe("false");
  });

  it("jobがnullなら中立値を返す", () => {
    render(<Probe job={null} phaseProgressSeconds={null} />);
    expect(screen.getByTestId("percent").textContent).toBe("0.0");
    expect(screen.getByTestId("remaining").textContent).toBe("null");
    expect(screen.getByTestId("retry").textContent).toBe("false");
  });
});
