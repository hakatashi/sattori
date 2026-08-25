import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { BYTES_PER_GB, CLOUDFRONT_FREE_TIER_GB_PER_MONTH, USD_TO_JPY_RATE } from "@sattori/shared";
import type { AdminCostSummaryResponse } from "@sattori/shared";
import { CostsPage } from "./CostsPage.tsx";
import { AdminAuthContext } from "./AdminAuthContext.ts";
import { CostCurrencyContext } from "./adminCurrency.ts";
import type { CostCurrency } from "./adminCurrency.ts";
import * as adminApi from "./adminApi.ts";

vi.mock("./adminApi.ts", () => ({
  AdminUnauthorizedError: class extends Error {},
  fetchAdminCosts: vi.fn(),
}));

const mocked = vi.mocked(adminApi);

const response: AdminCostSummaryResponse = {
  granularity: "monthly",
  jobCount: 3,
  totalJobCount: 5,
  buckets: [
    {
      key: "2026-08",
      jobCount: 2,
      doneCount: 1,
      failedCount: 1,
      homeWorkerJobCount: 0,
      breakdown: { ec2Spot: 0.08, ebs: 0.004, publicIpv4: 0.006, s3Storage: 0.02, misc: 0.004 },
      totalUsd: 0.114,
      billedSeconds: 4320,
      deliveryBytes: 2 * BYTES_PER_GB,
      storedBytes: 3 * BYTES_PER_GB,
    },
    {
      key: "2026-07",
      jobCount: 1,
      doneCount: 1,
      failedCount: 0,
      homeWorkerJobCount: 0,
      breakdown: { ec2Spot: 0.04, ebs: 0.002, publicIpv4: 0.003, s3Storage: 0.01, misc: 0.002 },
      totalUsd: 0.057,
      billedSeconds: 2160,
      deliveryBytes: BYTES_PER_GB,
      storedBytes: 1.5 * BYTES_PER_GB,
    },
  ],
  cloudFront: [
    {
      month: "2026-08",
      deliveryBytes: (CLOUDFRONT_FREE_TIER_GB_PER_MONTH + 100) * BYTES_PER_GB,
      deliveryGb: CLOUDFRONT_FREE_TIER_GB_PER_MONTH + 100,
      overageGb: 100,
      usd: 8.5,
      measuredDeliveryBytes: (CLOUDFRONT_FREE_TIER_GB_PER_MONTH + 150) * BYTES_PER_GB,
    },
  ],
  quality: {
    assumedDurationJobs: 1,
    fallbackSpotPriceJobs: 0,
    unknownOutputSizeJobs: 0,
  },
};

function renderPage(initialEntry = "/admin/costs", currency: CostCurrency = "usd") {
  return render(
    <AdminAuthContext.Provider value={{ token: "token", onUnauthorized: vi.fn() }}>
      <CostCurrencyContext.Provider value={{ currency, setCurrency: vi.fn() }}>
        <MemoryRouter initialEntries={[initialEntry]}>
          <CostsPage />
        </MemoryRouter>
      </CostCurrencyContext.Provider>
    </AdminAuthContext.Provider>,
  );
}

describe("CostsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked.fetchAdminCosts.mockResolvedValue(response);
  });

  it("既定では月次で取得し、合計と1ジョブ平均を表示する", async () => {
    renderPage();

    await waitFor(() => {
      expect(mocked.fetchAdminCosts).toHaveBeenCalledWith("token", { granularity: "monthly" });
    });
    // 表示期間の合計 = 0.114 + 0.057
    expect(await screen.findByText("$0.17")).toBeTruthy();
    // 1ジョブ平均 = 0.171 / 3
    expect(screen.getByText("$0.0570")).toBeTruthy();
    expect(screen.getByText("全期間 5 件")).toBeTruthy();
  });

  it("URLの検索パラメータから粒度を読み、変更すると再取得する", async () => {
    renderPage("/admin/costs?granularity=daily");

    await waitFor(() => {
      expect(mocked.fetchAdminCosts).toHaveBeenCalledWith("token", { granularity: "daily" });
    });

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "weekly" } });
    await waitFor(() => {
      expect(mocked.fetchAdminCosts).toHaveBeenCalledWith("token", { granularity: "weekly" });
    });
  });

  it("内訳の凡例に系列名と期間合計を併記する（色だけに依存させない）", async () => {
    renderPage();

    expect(await screen.findByText("EC2 Spot")).toBeTruthy();
    expect(screen.getByText("S3 保管")).toBeTruthy();
    // EC2 Spot の期間合計 = 0.08 + 0.04
    expect(screen.getByText("$0.12")).toBeTruthy();
  });

  it("バケットごとに合計金額とジョブ数・失敗件数を出す", async () => {
    renderPage();

    // "2026-08"は積み上げ棒の行見出しとCloudFront表の両方に出るため、
    // バケット側にしか無い"2026-07"で待つ。
    expect(await screen.findByText("2026-07")).toBeTruthy();
    expect(screen.getByText("$0.11")).toBeTruthy();
    expect(screen.getByText("（失敗1）")).toBeTruthy();
  });

  it("CloudFrontの無料枠超過を月次で表示する", async () => {
    renderPage();

    expect(await screen.findByText("$8.50")).toBeTruthy();
    expect(screen.getByText("100.0 GB")).toBeTruthy();
  });

  it("CloudFrontの実測配信量（Issue #163）を併記する", async () => {
    renderPage();

    expect(await screen.findByText("1150.00 GiB")).toBeTruthy();
  });

  it("実測値が取得できていない月は「-」を表示する", async () => {
    mocked.fetchAdminCosts.mockResolvedValue({
      ...response,
      cloudFront: [{ ...response.cloudFront[0]!, measuredDeliveryBytes: null }],
    });
    renderPage();

    expect(await screen.findByText("$8.50")).toBeTruthy();
    expect(screen.getAllByText("-").length).toBeGreaterThan(0);
  });

  it("APIがmeasuredDeliveryBytesを返さない場合（デプロイ前後の不整合）でも「NaN MiB」にならず「-」にする", async () => {
    const { measuredDeliveryBytes: _omit, ...staleMonth } = response.cloudFront[0]!;
    mocked.fetchAdminCosts.mockResolvedValue({
      ...response,
      cloudFront: [staleMonth as (typeof response.cloudFront)[number]],
    });
    renderPage();

    expect(await screen.findByText("$8.50")).toBeTruthy();
    expect(screen.getAllByText("-").length).toBeGreaterThan(0);
    expect(screen.queryByText(/NaN/)).toBeNull();
  });

  it("推定に仮定が混ざっている場合は注記を出す", async () => {
    renderPage();

    expect(
      await screen.findByText(/1\/3件は起動時刻\(launchedAt\)が未記録/),
    ).toBeTruthy();
    // カウンタが0の項目は注記しない。
    expect(screen.queryByText(/Spot単価が未記録/)).toBeNull();
  });

  it("仮定が一切無ければ注記そのものを出さない", async () => {
    mocked.fetchAdminCosts.mockResolvedValue({
      ...response,
      quality: { assumedDurationJobs: 0, fallbackSpotPriceJobs: 0, unknownOutputSizeJobs: 0 },
    });
    renderPage();

    await screen.findByText("2026-07");
    expect(screen.queryByText("推定の確からしさ")).toBeNull();
  });

  it("バケットが無ければ空の案内を出す", async () => {
    mocked.fetchAdminCosts.mockResolvedValue({
      ...response,
      buckets: [],
      cloudFront: [],
      jobCount: 0,
    });
    renderPage();

    expect(await screen.findByText("該当するジョブがありません")).toBeTruthy();
    expect(screen.getByText("配信量の記録がありません")).toBeTruthy();
  });

  it("表示通貨に円を選ぶと合計・凡例・CloudFrontを円換算する", async () => {
    renderPage("/admin/costs", "jpy");

    // 表示期間の合計 = (0.114 + 0.057) USD。円は小数0桁（$表示の2桁から2桁落とす）。
    const totalJpy = Math.round(0.171 * USD_TO_JPY_RATE).toLocaleString("ja-JP");
    expect(await screen.findByText(`¥${totalJpy}`)).toBeTruthy();
    // CloudFront超過分 8.5 USD。
    const cloudFrontJpy = Math.round(8.5 * USD_TO_JPY_RATE).toLocaleString("ja-JP");
    expect(screen.getByText(`¥${cloudFrontJpy}`)).toBeTruthy();
    expect(screen.queryByText("$0.17")).toBeNull();
    expect(screen.getByText(/固定レートで換算した概算/)).toBeTruthy();
  });

  it("既定のUSD表示では為替レートの注記を出さない", async () => {
    renderPage();

    await screen.findByText("2026-07");
    expect(screen.queryByText(/固定レートで換算した概算/)).toBeNull();
  });
});
