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
    errorCode: null,
    updatedAt: new Date().toISOString(),
    progress: 100,
    previewVideoUrl: null,
    previewImageUrl: null,
    replayInfo: REPLAY_INFO,
    slowMotion: false,
    desyncDetected: null,
    timedOut: null,
    ...overrides,
  };
}

function Probe({ job }: { job: GetJobResponse | null }) {
  const progress = useEstimatedProgress(job);
  return <span data-testid="progress">{progress === null ? "null" : progress.toFixed(2)}</span>;
}

function currentProgress(): number {
  return Number(screen.getByTestId("progress").textContent);
}

describe("useEstimatedProgress", () => {
  it("録画フェーズでは実時間の経過とともに1倍速で進捗が伸びる", () => {
    vi.useFakeTimers();
    const now = new Date("2026-01-01T00:00:00.000Z");
    vi.setSystemTime(now);
    const job = buildJob({ status: "recording", progress: 100, updatedAt: now.toISOString() });

    render(<Probe job={job} />);
    // サーバー値(100)はワーカーの書き込み間隔(10秒)ぶん古くなり得るため、表示は
    // そのぶん手前から始める。追い越さずに動き続けるための「のりしろ」。
    const initial = currentProgress();
    expect(initial).toBeCloseTo(90, 5);

    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(currentProgress()).toBeCloseTo(94, 5);
  });

  it("変換フェーズでは録画フェーズより速く進捗が伸びる", () => {
    vi.useFakeTimers();
    const now = new Date("2026-01-01T00:00:00.000Z");
    vi.setSystemTime(now);
    const job = buildJob({ status: "converting", progress: 100, updatedAt: now.toISOString() });

    render(<Probe job={job} />);
    const initial = currentProgress();

    act(() => {
      vi.advanceTimersByTime(4000);
    });
    // 4倍速で補間されるので、同じ4秒でも録画フェーズ(+4秒)より大きく伸びる。
    expect(currentProgress() - initial).toBeGreaterThan(15);
  });

  it("ポーリングで得たサーバー値を追い越さない", () => {
    vi.useFakeTimers();
    const now = new Date("2026-01-01T00:00:00.000Z");
    vi.setSystemTime(now);
    const job = buildJob({ status: "recording", progress: 100, updatedAt: now.toISOString() });

    render(<Probe job={job} />);

    // 次のポーリング結果が来ないまま長時間経っても、直近のサーバー値で頭打ちになる。
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(currentProgress()).toBe(100);
  });

  it("estimatedDurationSecondsを超えて伸びない", () => {
    vi.useFakeTimers();
    const now = new Date("2026-01-01T00:00:00.000Z");
    vi.setSystemTime(now);
    // サーバーがリプレイの推定長(800秒)を超える進捗を報告してもクランプする。
    const job = buildJob({ status: "converting", progress: 850, updatedAt: now.toISOString() });

    render(<Probe job={job} />);

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(currentProgress()).toBe(800);
  });

  it("新しいジョブ情報の進捗が表示より小さくても巻き戻らない", () => {
    vi.useFakeTimers();
    const now = new Date("2026-01-01T00:00:00.000Z");
    vi.setSystemTime(now);
    const job1 = buildJob({ status: "recording", progress: 100, updatedAt: now.toISOString() });

    const { rerender } = render(<Probe job={job1} />);
    act(() => {
      vi.advanceTimersByTime(9000);
    });
    const before = currentProgress();
    expect(before).toBeCloseTo(99, 5);

    // 何らかの理由でサーバー値が後退しても（フェーズを跨いだ進捗の持ち越し等）、
    // 表示は据え置く。決して戻さない。
    const laterNow = new Date(now.getTime() + 9000);
    vi.setSystemTime(laterNow);
    const job2 = buildJob({ status: "recording", progress: 40, updatedAt: laterNow.toISOString() });
    rerender(<Probe job={job2} />);
    expect(currentProgress()).toBe(before);

    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(currentProgress()).toBe(before);
  });

  it("進捗が飛んで届いても巻き戻さずに追いつく", () => {
    vi.useFakeTimers();
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    vi.setSystemTime(t0);
    const job1 = buildJob({ status: "recording", progress: 100, updatedAt: t0.toISOString() });

    const { rerender } = render(<Probe job={job1} />);
    const initial = currentProgress();

    // タブが裏に回るなどして表示が止まっている間に、サーバー側は大きく進んだ。
    const t1 = new Date(t0.getTime() + 3000);
    vi.setSystemTime(t1);
    const job2 = buildJob({ status: "recording", progress: 200, updatedAt: t1.toISOString() });
    rerender(<Probe job={job2} />);

    // 遅れは1倍速ではなく、ワーカーの書き込み間隔(10秒)で埋め切る速度で取り戻す
    // （ただし一足飛びにサーバー値へ飛びつきはしない）。
    const catchingUp = currentProgress();
    expect(catchingUp).toBeGreaterThan(initial);
    expect(catchingUp).toBeLessThan(200);

    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(currentProgress()).toBe(200);
  });

  it("フェーズが変わると新しいフェーズの進捗で数え直す", () => {
    vi.useFakeTimers();
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    vi.setSystemTime(t0);
    const job1 = buildJob({ status: "recording", progress: 780, updatedAt: t0.toISOString() });

    const { rerender } = render(<Probe job={job1} />);
    expect(currentProgress()).toBeGreaterThan(700);

    // 変換フェーズは0から数え直す別のカウンタ（UI上も別の行に表示される）。
    const t1 = new Date(t0.getTime() + 3000);
    vi.setSystemTime(t1);
    const job2 = buildJob({ status: "converting", progress: 0, updatedAt: t1.toISOString() });
    rerender(<Probe job={job2} />);
    expect(currentProgress()).toBe(0);
  });

  it("実際のポーリング周期を通しても巻き戻らず、サーバー値も追い越さない", () => {
    // ワーカーは10秒間隔でしか進捗を書かず(worker/progress_reporter.py)、ブラウザは
    // それを3秒間隔で拾う(useJobPolling.ts)。この2つの周期が噛み合わない状態を
    // 通しで再現し、表示が「巻き戻らない」「サーバー値を追い越さない」「止まらない」
    // ことを確認する。
    vi.useFakeTimers();
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    vi.setSystemTime(t0);

    let serverProgress = 0;
    let serverUpdatedAt = t0;
    const { rerender } = render(
      <Probe job={buildJob({ status: "recording", progress: 0, updatedAt: t0.toISOString() })} />,
    );

    let previous = currentProgress();
    for (let elapsedMs = 3000; elapsedMs <= 300_000; elapsedMs += 3000) {
      vi.setSystemTime(new Date(t0.getTime() + elapsedMs));
      act(() => {
        vi.advanceTimersByTime(3000);
      });
      // ワーカーが進捗を書くのは10秒毎。ポーリングはその間、同じ値を拾い続ける。
      const lastWriteMs = Math.floor(elapsedMs / 10_000) * 10_000;
      serverUpdatedAt = new Date(t0.getTime() + lastWriteMs);
      serverProgress = lastWriteMs / 1000;
      rerender(
        <Probe
          job={buildJob({
            status: "recording",
            progress: serverProgress,
            updatedAt: serverUpdatedAt.toISOString(),
          })}
        />,
      );

      const value = currentProgress();
      expect(value).toBeGreaterThanOrEqual(previous);
      expect(value).toBeLessThanOrEqual(serverProgress);
      previous = value;
    }
    // 止まったままにもならない（10秒に1度しか真の値が動かなくても進み続ける）。
    expect(previous).toBeGreaterThan(250);
  });

  it("progressがnullなら推定せずnullを返す", () => {
    const job = buildJob({ status: "queued", progress: null });
    render(<Probe job={job} />);
    expect(screen.getByTestId("progress").textContent).toBe("null");
  });

  it("録画・変換以外のフェーズでは進捗が残っていても表示しない", () => {
    // リトライ後の launching には前の試行の進捗が残っている（APIはstatusしか
    // 書き換えない）。これを表示すると録画開始時に巻き戻って見える。
    const job = buildJob({ status: "launching", progress: 500 });
    render(<Probe job={job} />);
    expect(screen.getByTestId("progress").textContent).toBe("null");
  });

  it("変換フェーズで過去2回分のポーリング結果から速度を逆算し、既定値ではなく実測速度で補間する", () => {
    vi.useFakeTimers();
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    vi.setSystemTime(t0);
    const job1 = buildJob({ status: "converting", progress: 100, updatedAt: t0.toISOString() });

    const { rerender } = render(<Probe job={job1} />);

    // 3秒間、実測データ無しの既定速度(4倍速)で補間される。
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    const beforeSecondPoll = currentProgress();
    expect(beforeSecondPoll).toBeCloseTo(72, 5); // 100 - 10*4 = 60 から 4倍速で3秒

    // ここで届いた2回目のポーリング結果は実測速度6倍速相当（100→118, 3秒経過）。
    const t1 = new Date(t0.getTime() + 3000);
    vi.setSystemTime(t1);
    const job2 = buildJob({ status: "converting", progress: 118, updatedAt: t1.toISOString() });
    rerender(<Probe job={job2} />);
    expect(currentProgress()).toBe(beforeSecondPoll);

    // 以降は実測した6倍速を使って補間されるはず
    // （既定の4倍速なら 72+2.5*max(4, (118-72)/10)=83.5 止まり）。
    act(() => {
      vi.advanceTimersByTime(2500);
    });
    expect(currentProgress()).toBeCloseTo(87, 5);
  });
});
