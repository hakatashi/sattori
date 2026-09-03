import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type {
  AdminExecutionResponse,
  AdminJobDetailResponse,
  AdminJobRecord,
  AdminLogsResponse,
} from "@sattori/shared";
import { JobDetailPage } from "./JobDetailPage.tsx";
import { AdminAuthContext } from "./AdminAuthContext.ts";
import * as adminApi from "./adminApi.ts";

vi.mock("./adminApi.ts", () => ({
  AdminUnauthorizedError: class extends Error {},
  fetchAdminJobDetail: vi.fn(),
  fetchAdminExecution: vi.fn(),
  fetchAdminLogs: vi.fn(),
  stopAdminJob: vi.fn(),
  retryAdminJob: vi.fn(),
}));

const mocked = vi.mocked(adminApi);

const job: AdminJobRecord = {
  jobId: "job-1",
  game: "th11",
  replayKey: "replays/abc.rpy",
  status: "recording",
  options: { watermark: true, slowMotion: false, th10BugfixMarisaB: false },
  outputPath: "videos/job-1.mp4",
  outputPath720p: null,
  error: null,
  errorCode: null,
  createdAt: "2026-07-30T00:00:00.000Z",
  updatedAt: "2026-07-30T00:00:00.000Z",
  doneAt: null,
  email: "user@example.com",
  instanceId: "i-1234",
  workerKind: "ec2",
  instanceType: "c7i.2xlarge",
  availabilityZone: "us-east-1a",
  spotPricePerHour: null,
  launchedAt: null,
  outputBytes: null,
  outputBytes720p: null,
  estimatedDurationSeconds: 900,
  progress: 120,
  previewImagePath: "progress/job-1/1234.jpg",
  posterImagePath: null,
  replayInfo: null,
  pendingExpiresAt: null,
  retriedToJobId: null,
  retriedFromJobId: null,
  language: "ja",
  desyncDetected: null,
  timedOut: null,
};

const detailResponse: AdminJobDetailResponse = {
  job,
  downloads: {
    replayUrl: "https://up-bucket.s3.amazonaws.com/replays/abc.rpy?sig=1",
    videoUrl: "https://cdn.example.net/videos/job-1.mp4",
    video720pUrl: null,
    previewImageUrl: "https://cdn.example.net/progress/job-1/1234.jpg",
    ffmpegLogUrl: null,
  },
};

const executionResponse: AdminExecutionResponse = {
  execution: null,
  events: [],
  eventsNextToken: null,
};

const logsResponse: AdminLogsResponse = {
  logStreamFound: true,
  events: [],
  nextBackwardToken: null,
  consoleOutput: null,
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
    mocked.fetchAdminLogs.mockResolvedValue(logsResponse);
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
    // doneAtは実行時刻からの相対値にする。固定日時にすると、テスト実行日が
    // doneAt + OUTPUT_RETENTION_DAYS(7日)を過ぎた時点でexpired表示に化けてしまう
    // （実際にこれでテストが壊れたことがある）。
    const doneJob: AdminJobRecord = {
      ...job,
      status: "done",
      doneAt: new Date(Date.now() - 60_000).toISOString(),
    };
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

  it("ワーカーログをinstanceId付きで取得し、イベントを表示する", async () => {
    mocked.fetchAdminJobDetail.mockResolvedValue(detailResponse);
    mocked.fetchAdminLogs.mockResolvedValue({
      logStreamFound: true,
      events: [{ timestamp: 1753833600000, message: "recording started" }],
      nextBackwardToken: null,
      consoleOutput: null,
    });
    renderJobDetailPage();

    await waitFor(() => expect(screen.getByText(/recording started/)).toBeTruthy());
    expect(mocked.fetchAdminLogs).toHaveBeenCalledWith("token", "job-1", { instanceId: "i-1234" });
  });

  it("[ffmpeg]プレフィックスの進捗ログはデフォルトで非表示にし、チェックボックスで表示できる", async () => {
    mocked.fetchAdminJobDetail.mockResolvedValue(detailResponse);
    mocked.fetchAdminLogs.mockResolvedValue({
      logStreamFound: true,
      events: [
        { timestamp: 1753833600000, message: "recording started" },
        { timestamp: 1753833601000, message: "[entrypoint 10:12:57] [ffmpeg] frame=97119" },
      ],
      nextBackwardToken: null,
      consoleOutput: null,
    });
    renderJobDetailPage();

    await waitFor(() => expect(screen.getByText(/recording started/)).toBeTruthy());
    expect(screen.queryByText(/\[ffmpeg\] frame=/)).toBeNull();
    expect(screen.getByText(/1件非表示中/)).toBeTruthy();

    fireEvent.click(screen.getByRole("checkbox"));
    expect(screen.getByText(/\[ffmpeg\] frame=/)).toBeTruthy();
  });

  it("ffmpegLogUrlがあればS3のffmpeg生ログへのダウンロードリンクを表示する", async () => {
    mocked.fetchAdminJobDetail.mockResolvedValue({
      ...detailResponse,
      downloads: {
        ...detailResponse.downloads,
        ffmpegLogUrl: "https://out-bucket.s3.amazonaws.com/worker-logs/job-1/ffmpeg-upscale.log?sig=1",
      },
    });
    renderJobDetailPage();

    await waitFor(() =>
      expect(screen.getByText("720p変換のffmpeg生ログ(全行)をダウンロード")).toBeTruthy(),
    );
    const link = screen.getByText(
      "720p変換のffmpeg生ログ(全行)をダウンロード",
    ) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe(
      "https://out-bucket.s3.amazonaws.com/worker-logs/job-1/ffmpeg-upscale.log?sig=1",
    );
  });

  it("ユーザー向けジョブページ(ページB)へのリンクを別タブで開く形で表示する", async () => {
    mocked.fetchAdminJobDetail.mockResolvedValue(detailResponse);
    renderJobDetailPage();

    await waitFor(() => expect(screen.getByText(/ユーザー向けジョブページを開く/)).toBeTruthy());
    const link = screen.getByText(/ユーザー向けジョブページを開く/) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/jobs/job-1");
    expect(link.getAttribute("target")).toBe("_blank");
  });

  it("英語のジョブでは/en付きのユーザー向けジョブページへリンクする", async () => {
    mocked.fetchAdminJobDetail.mockResolvedValue({
      ...detailResponse,
      job: { ...job, language: "en" },
    });
    renderJobDetailPage();

    await waitFor(() => expect(screen.getByText(/ユーザー向けジョブページを開く/)).toBeTruthy());
    const link = screen.getByText(/ユーザー向けジョブページを開く/) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/en/jobs/job-1");
  });

  it("ログストリームが見つからない場合はコンソール出力へフォールバックする", async () => {
    mocked.fetchAdminJobDetail.mockResolvedValue(detailResponse);
    mocked.fetchAdminLogs.mockResolvedValue({
      logStreamFound: false,
      events: [],
      nextBackwardToken: null,
      consoleOutput: "boot failed: ECR login error",
    });
    renderJobDetailPage();

    await waitFor(() => expect(screen.getByText(/boot failed: ECR login error/)).toBeTruthy());
    expect(screen.getByText(/ログストリームが見つかりません/)).toBeTruthy();
  });

  describe("自宅ワーカーが実行したジョブ(Issue #49)", () => {
    const homeJob: AdminJobRecord = {
      ...job,
      workerKind: "home",
      instanceId: null,
      instanceType: null,
      availabilityZone: null,
      assignedWorkerId: "home-1",
      homeWorkerHeartbeatAt: "2026-07-30T00:05:00.000Z",
    };

    it("EC2の欄ではなく自宅ワーカーの欄を表示する", async () => {
      mocked.fetchAdminJobDetail.mockResolvedValue({ ...detailResponse, job: homeJob });
      renderJobDetailPage();

      await waitFor(() => expect(screen.getByText("ワーカー（自宅サーバー）")).toBeTruthy());
      expect(screen.getByText("home-1")).toBeTruthy();
      // EC2固有のフィールドは常に空になるだけなので出さない。
      expect(screen.queryByText("instanceType")).toBeNull();
      expect(screen.queryByText("availabilityZone")).toBeNull();
      expect(screen.queryByText("spotPricePerHour")).toBeNull();
    });

    it("緊急停止の説明をEC2の強制終了ではなく割り当て解除として表示する", async () => {
      mocked.fetchAdminJobDetail.mockResolvedValue({ ...detailResponse, job: homeJob });
      renderJobDetailPage();

      await waitFor(() => expect(screen.getByText(/自宅ワーカーへの割り当てを解除/)).toBeTruthy());
      expect(screen.queryByText(/緊急停止するとEC2インスタンスを強制終了/)).toBeNull();
    });

    it("コスト推定でSpot単価を出さず、EC2課金が無いことを注記する", async () => {
      mocked.fetchAdminJobDetail.mockResolvedValue({ ...detailResponse, job: homeJob });
      renderJobDetailPage();

      await waitFor(() => expect(screen.getByText("コスト推定")).toBeTruthy());
      // 計算に使われていないフォールバック単価が「この単価で課金された」と
      // 読まれてしまうため、自宅ワーカーのジョブでは表示しない。
      expect(screen.queryByText("Spot単価")).toBeNull();
      expect(screen.getByText(/自宅ワーカーが実行したため/)).toBeTruthy();
      expect(screen.getByText(/自宅ワーカーが実行（EC2課金なし）/)).toBeTruthy();
    });

    it("ログストリームが無い場合はEC2のUserDataではなくデーモン側の確認を促す", async () => {
      mocked.fetchAdminJobDetail.mockResolvedValue({ ...detailResponse, job: homeJob });
      mocked.fetchAdminLogs.mockResolvedValue({
        logStreamFound: false,
        events: [],
        nextBackwardToken: null,
        consoleOutput: null,
      });
      renderJobDetailPage();

      await waitFor(() => expect(screen.getByText(/journalctl -u sattori-home-worker/)).toBeTruthy());
      expect(screen.queryByText(/UserData\(bootstrap\)段階/)).toBeNull();
      // インスタンスが存在しないので、コンソール出力のフォールバックにも触れない。
      expect(screen.queryByText(/コンソール出力も取得できませんでした/)).toBeNull();
    });
  });

  describe("ワーカーログの追尾", () => {
    const olderEvent = { timestamp: 1753833600000, message: "recording started" };
    const newerEvent = { timestamp: 1753833660000, message: "converting started" };

    beforeEach(() => {
      // jsdomはレイアウトを計算せずscrollHeight/clientHeightが常に0になるため、
      // 「末尾までスクロールしているか」を判定できるよう寸法を与える。
      Object.defineProperty(HTMLPreElement.prototype, "scrollHeight", {
        configurable: true,
        value: 500,
      });
      Object.defineProperty(HTMLPreElement.prototype, "clientHeight", {
        configurable: true,
        value: 100,
      });
    });

    afterEach(() => {
      Reflect.deleteProperty(HTMLPreElement.prototype, "scrollHeight");
      Reflect.deleteProperty(HTMLPreElement.prototype, "clientHeight");
      vi.useRealTimers();
    });

    it("初回読み込み後にログの末尾までスクロールする", async () => {
      mocked.fetchAdminJobDetail.mockResolvedValue(detailResponse);
      mocked.fetchAdminLogs.mockResolvedValue({
        logStreamFound: true,
        events: [olderEvent],
        nextBackwardToken: null,
        consoleOutput: null,
      });
      renderJobDetailPage();

      await waitFor(() => expect(screen.getByText(/recording started/)).toBeTruthy());
      expect((screen.getByText(/recording started/) as HTMLPreElement).scrollTop).toBe(500);
    });

    it("実行中のジョブでは定期的に最新のログを取得し、末尾へスクロールする", async () => {
      vi.useFakeTimers();
      mocked.fetchAdminJobDetail.mockResolvedValue(detailResponse);
      mocked.fetchAdminLogs
        .mockResolvedValueOnce({
          logStreamFound: true,
          events: [olderEvent],
          nextBackwardToken: null,
          consoleOutput: null,
        })
        .mockResolvedValue({
          logStreamFound: true,
          events: [olderEvent, newerEvent],
          nextBackwardToken: null,
          consoleOutput: null,
        });
      renderJobDetailPage();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByText(/recording started/)).toBeTruthy();
      const pre = screen.getByText(/recording started/) as HTMLPreElement;
      pre.scrollTop = 500;

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });

      expect(mocked.fetchAdminLogs).toHaveBeenCalledTimes(2);
      expect(screen.getByText(/converting started/)).toBeTruthy();
      expect(pre.scrollTop).toBe(500);
    });

    it("末尾から離れてスクロールしている間は自動取得しない", async () => {
      vi.useFakeTimers();
      mocked.fetchAdminJobDetail.mockResolvedValue(detailResponse);
      mocked.fetchAdminLogs.mockResolvedValue({
        logStreamFound: true,
        events: [olderEvent],
        nextBackwardToken: null,
        consoleOutput: null,
      });
      renderJobDetailPage();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      const pre = screen.getByText(/recording started/) as HTMLPreElement;
      // 履歴を遡って読んでいる状態（scrollHeight 500 - scrollTop 0 - clientHeight 100）。
      pre.scrollTop = 0;
      fireEvent.scroll(pre);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });

      expect(mocked.fetchAdminLogs).toHaveBeenCalledTimes(1);
      expect(screen.getByText(/自動取得を停止しています/)).toBeTruthy();
      // 勝手に末尾へ飛ばさない。
      expect(pre.scrollTop).toBe(0);
    });

    it("終了済みのジョブでは自動取得しない", async () => {
      vi.useFakeTimers();
      mocked.fetchAdminJobDetail.mockResolvedValue({
        ...detailResponse,
        job: { ...job, status: "done", doneAt: "2026-07-30T00:10:00.000Z" },
      });
      mocked.fetchAdminLogs.mockResolvedValue({
        logStreamFound: true,
        events: [olderEvent],
        nextBackwardToken: null,
        consoleOutput: null,
      });
      renderJobDetailPage();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });

      expect(mocked.fetchAdminLogs).toHaveBeenCalledTimes(1);
      expect(screen.queryByText(/秒ごとに最新のログを自動取得/)).toBeNull();
    });
  });

  describe("操作パネル(Issue #59)", () => {
    const doneJob: AdminJobRecord = { ...job, status: "done", doneAt: "2026-07-30T00:10:00.000Z" };

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("実行中のジョブでは緊急停止だけが押せる", async () => {
      mocked.fetchAdminJobDetail.mockResolvedValue(detailResponse);
      renderJobDetailPage();

      await waitFor(() => expect(screen.getByRole("button", { name: "緊急停止" })).toBeTruthy());
      expect(screen.getByRole("button", { name: "緊急停止" }).hasAttribute("disabled")).toBe(false);
      expect(screen.getByRole("button", { name: "再実行" }).hasAttribute("disabled")).toBe(true);
    });

    it("終了済みのジョブでは再実行だけが押せる", async () => {
      mocked.fetchAdminJobDetail.mockResolvedValue({ ...detailResponse, job: doneJob });
      renderJobDetailPage();

      await waitFor(() => expect(screen.getByRole("button", { name: "再実行" })).toBeTruthy());
      expect(screen.getByRole("button", { name: "再実行" }).hasAttribute("disabled")).toBe(false);
      expect(screen.getByRole("button", { name: "緊急停止" }).hasAttribute("disabled")).toBe(true);
    });

    it("statusがfailedでも緊急停止は押せる(実行がリトライ中の可能性があるため)", async () => {
      // ワーカーはSendTaskFailureより先にfailedを書くため、statusがfailedでも
      // ステートマシンが最大10回までEC2を起動し直していることがある。UIで
      // 押せなくしてしまうと、その暴走を止める手段が無くなる。
      const failedJob: AdminJobRecord = { ...job, status: "failed", error: "録画に失敗しました" };
      mocked.fetchAdminJobDetail.mockResolvedValue({ ...detailResponse, job: failedJob });
      renderJobDetailPage();

      await waitFor(() => expect(screen.getByRole("button", { name: "緊急停止" })).toBeTruthy());
      expect(screen.getByRole("button", { name: "緊急停止" }).hasAttribute("disabled")).toBe(false);
      expect(screen.getByText(/Step\s+Functionsがリトライ中/)).toBeTruthy();
    });

    it("再実行済みのジョブでは再実行を押せない(二重録画を避ける)", async () => {
      mocked.fetchAdminJobDetail.mockResolvedValue({
        ...detailResponse,
        job: { ...doneJob, retriedToJobId: "job-2" },
      });
      renderJobDetailPage();

      await waitFor(() => expect(screen.getByRole("button", { name: "再実行" })).toBeTruthy());
      expect(screen.getByRole("button", { name: "再実行" }).hasAttribute("disabled")).toBe(true);
      expect(screen.getByText(/既に再実行済みです/)).toBeTruthy();
    });

    it("停止処理中に録画が完了していた場合はstatusがdoneのままであることを伝える", async () => {
      vi.spyOn(window, "confirm").mockReturnValue(true);
      mocked.fetchAdminJobDetail.mockResolvedValue(detailResponse);
      mocked.stopAdminJob.mockResolvedValue({
        jobId: "job-1",
        status: "done",
        executionStopped: true,
        instanceTerminated: true,
        homeWorkerReleased: false,
      });
      renderJobDetailPage();

      await waitFor(() => expect(screen.getByRole("button", { name: "緊急停止" })).toBeTruthy());
      fireEvent.click(screen.getByRole("button", { name: "緊急停止" }));

      await waitFor(() => expect(screen.getByText(/statusはdoneのままです/)).toBeTruthy());
    });

    it("確認ダイアログをキャンセルすると停止APIを呼ばない", async () => {
      vi.spyOn(window, "confirm").mockReturnValue(false);
      mocked.fetchAdminJobDetail.mockResolvedValue(detailResponse);
      renderJobDetailPage();

      await waitFor(() => expect(screen.getByRole("button", { name: "緊急停止" })).toBeTruthy());
      fireEvent.click(screen.getByRole("button", { name: "緊急停止" }));

      expect(window.confirm).toHaveBeenCalled();
      expect(mocked.stopAdminJob).not.toHaveBeenCalled();
    });

    it("停止に成功したら結果を表示し、ジョブ詳細を取り直す", async () => {
      vi.spyOn(window, "confirm").mockReturnValue(true);
      mocked.fetchAdminJobDetail.mockResolvedValue(detailResponse);
      mocked.stopAdminJob.mockResolvedValue({
        jobId: "job-1",
        status: "failed",
        executionStopped: true,
        instanceTerminated: true,
        homeWorkerReleased: false,
      });
      renderJobDetailPage();

      await waitFor(() => expect(screen.getByRole("button", { name: "緊急停止" })).toBeTruthy());
      fireEvent.click(screen.getByRole("button", { name: "緊急停止" }));

      await waitFor(() => expect(screen.getByText(/停止しました/)).toBeTruthy());
      expect(mocked.stopAdminJob).toHaveBeenCalledWith("token", "job-1");
      // 初回取得 + 停止後の再取得。再取得は`useAdminResource.reload()`のstate更新を
      // 経てuseEffectから発火するため、結果メッセージが描画されたのと同じティックとは
      // 限らない（即時にアサートするとCIのような遅い環境で取りこぼす）。
      await waitFor(() => expect(mocked.fetchAdminJobDetail).toHaveBeenCalledTimes(2));
    });

    it("再実行に成功したら新しいjobIdへのリンクを表示する", async () => {
      vi.spyOn(window, "confirm").mockReturnValue(true);
      mocked.fetchAdminJobDetail.mockResolvedValue({ ...detailResponse, job: doneJob });
      mocked.retryAdminJob.mockResolvedValue({
        sourceJobId: "job-1",
        jobId: "job-2",
        status: "queued",
      });
      renderJobDetailPage();

      await waitFor(() => expect(screen.getByRole("button", { name: "再実行" })).toBeTruthy());
      fireEvent.click(screen.getByRole("button", { name: "再実行" }));

      await waitFor(() => expect(screen.getByText("job-2")).toBeTruthy());
      expect(mocked.retryAdminJob).toHaveBeenCalledWith("token", "job-1");
      expect((screen.getByText("job-2") as HTMLAnchorElement).getAttribute("href")).toBe(
        "/admin/jobs/job-2",
      );
    });

    it("失敗時はエラーメッセージを表示する", async () => {
      vi.spyOn(window, "confirm").mockReturnValue(true);
      mocked.fetchAdminJobDetail.mockResolvedValue(detailResponse);
      mocked.stopAdminJob.mockRejectedValue(new Error("Step Functions実行の停止に失敗しました"));
      renderJobDetailPage();

      await waitFor(() => expect(screen.getByRole("button", { name: "緊急停止" })).toBeTruthy());
      fireEvent.click(screen.getByRole("button", { name: "緊急停止" }));

      await waitFor(() =>
        expect(screen.getByText("Step Functions実行の停止に失敗しました")).toBeTruthy(),
      );
      expect(mocked.fetchAdminJobDetail).toHaveBeenCalledTimes(1);
    });

    it("retriedToJobIdがあれば再実行後のジョブ詳細へのリンクを出す", async () => {
      mocked.fetchAdminJobDetail.mockResolvedValue({
        ...detailResponse,
        job: { ...doneJob, retriedToJobId: "job-2" },
      });
      renderJobDetailPage();

      await waitFor(() => expect(screen.getByText("job-2")).toBeTruthy());
      expect((screen.getByText("job-2") as HTMLAnchorElement).getAttribute("href")).toBe(
        "/admin/jobs/job-2",
      );
    });
  });
});
