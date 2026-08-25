import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { AdminAnalyticsSummaryResponse } from "@sattori/shared";
import { AnalyticsPage } from "./AnalyticsPage.tsx";
import { AdminAuthContext } from "./AdminAuthContext.ts";
import * as adminApi from "./adminApi.ts";

vi.mock("./adminApi.ts", () => ({
  AdminUnauthorizedError: class extends Error {},
  fetchAdminAnalytics: vi.fn(),
}));

const mocked = vi.mocked(adminApi);

const response: AdminAnalyticsSummaryResponse = {
  days: 30,
  from: "2026-07-27",
  to: "2026-08-25",
  daily: [
    { date: "2026-08-24", pageviews: 10, uniqueVisitors: 4, parseErrors: 1 },
    { date: "2026-08-25", pageviews: 20, uniqueVisitors: 8, parseErrors: 0 },
  ],
  totals: { pageviews: 30, uniqueVisitorDays: 12, parseErrors: 1 },
  breakdowns: {
    paths: [{ key: "/", count: 25 }, { key: "/en/", count: 5 }],
    referrers: [{ key: "(direct)", count: 20 }, { key: "google.com", count: 10 }],
    countries: [{ key: "JP", count: 28 }, { key: "(unknown)", count: 2 }],
    languages: [{ key: "ja", count: 27 }],
    deviceCategories: [{ key: "desktop", count: 22 }, { key: "mobile", count: 8 }],
    browserFamilies: [{ key: "chrome", count: 24 }],
    osFamilies: [{ key: "windows", count: 20 }],
    utmSources: [{ key: "twitter", count: 3 }],
    parseErrorCodes: [{ key: "unsupported_game", count: 1 }],
    parseErrorGames: [{ key: "th19", count: 1 }],
  },
};

function renderPage(initialEntry = "/admin/analytics") {
  return render(
    <AdminAuthContext.Provider value={{ token: "token", onUnauthorized: vi.fn() }}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <AnalyticsPage />
      </MemoryRouter>
    </AdminAuthContext.Provider>,
  );
}

describe("AnalyticsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked.fetchAdminAnalytics.mockResolvedValue(response);
  });

  it("既定では30日で取得し、合計値を表示する", async () => {
    renderPage();

    await waitFor(() => {
      expect(mocked.fetchAdminAnalytics).toHaveBeenCalledWith("token", 30);
    });
    expect(await screen.findByText("30")).toBeTruthy();
    expect(screen.getByText("12")).toBeTruthy();
    expect(screen.getByText("日をまたぐ重複は排除できません")).toBeTruthy();
  });

  it("URLの検索パラメータから期間を読み、変更すると再取得する", async () => {
    renderPage("/admin/analytics?days=7");

    await waitFor(() => {
      expect(mocked.fetchAdminAnalytics).toHaveBeenCalledWith("token", 7);
    });

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "90" } });
    await waitFor(() => {
      expect(mocked.fetchAdminAnalytics).toHaveBeenCalledWith("token", 90);
    });
  });

  it("日別推移を新しい順で表示する", async () => {
    renderPage();

    const rows = await screen.findAllByRole("row");
    // rows[0]はヘッダー行、rows[1]が最初のデータ行（新しい順なので25日が先頭）。
    expect(rows[1]?.textContent).toContain("2026-08-25");
    expect(rows[2]?.textContent).toContain("2026-08-24");
  });

  it("属性別の内訳カードを表示する", async () => {
    renderPage();

    expect(await screen.findByText("ページ")).toBeTruthy();
    expect(screen.getByText("google.com")).toBeTruthy();
    expect(screen.getByText("th19")).toBeTruthy();
  });

  it("イベントが無ければ空の案内を出す", async () => {
    mocked.fetchAdminAnalytics.mockResolvedValue({
      ...response,
      daily: [],
      totals: { pageviews: 0, uniqueVisitorDays: 0, parseErrors: 0 },
      breakdowns: {
        paths: [],
        referrers: [],
        countries: [],
        languages: [],
        deviceCategories: [],
        browserFamilies: [],
        osFamilies: [],
        utmSources: [],
        parseErrorCodes: [],
        parseErrorGames: [],
      },
    });
    renderPage();

    expect(await screen.findByText("該当する期間のイベントがありません")).toBeTruthy();
    expect(screen.getAllByText("データがありません").length).toBeGreaterThan(0);
  });
});
