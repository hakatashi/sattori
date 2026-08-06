import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AdminSettingsResponse } from "@sattori/shared";
import { SettingsPage } from "./SettingsPage.tsx";
import { AdminAuthContext } from "./AdminAuthContext.ts";
import { CostCurrencyContext } from "./adminCurrency.ts";
import * as adminApi from "./adminApi.ts";

vi.mock("./adminApi.ts", () => ({
  AdminUnauthorizedError: class extends Error {},
  fetchAdminSettings: vi.fn(),
  updateAdminSettings: vi.fn(),
}));

const mocked = vi.mocked(adminApi);

const baseResponse: AdminSettingsResponse = {
  acceptingNewJobs: true,
  monthlyCostLimitUsd: 50,
  currentMonthCostUsd: 12.5,
  costLimitReached: false,
};

function renderPage() {
  return render(
    <AdminAuthContext.Provider value={{ token: "token", onUnauthorized: vi.fn() }}>
      <CostCurrencyContext.Provider value={{ currency: "usd", setCurrency: vi.fn() }}>
        <SettingsPage />
      </CostCurrencyContext.Provider>
    </AdminAuthContext.Provider>,
  );
}

describe("SettingsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked.fetchAdminSettings.mockResolvedValue(baseResponse);
  });

  it("現在の受付状態と当月コストを表示する", async () => {
    renderPage();

    expect(await screen.findByText("受付中")).toBeTruthy();
    expect(screen.getByText(/\$12\.50 \/ \$50\.00/)).toBeTruthy();
  });

  it("キルスイッチを停止する操作は確認ダイアログを経て呼ばれる", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    mocked.updateAdminSettings.mockResolvedValue({ ...baseResponse, acceptingNewJobs: false });
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "新規録画の受付を停止する" }));

    await waitFor(() => {
      expect(mocked.updateAdminSettings).toHaveBeenCalledWith("token", {
        acceptingNewJobs: false,
      });
    });
    expect(confirmSpy).toHaveBeenCalled();
  });

  it("確認ダイアログでキャンセルすれば更新APIを呼ばない", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "新規録画の受付を停止する" }));

    expect(mocked.updateAdminSettings).not.toHaveBeenCalled();
  });

  it("停止中なら再開ボタンを表示する", async () => {
    mocked.fetchAdminSettings.mockResolvedValue({ ...baseResponse, acceptingNewJobs: false });
    renderPage();

    expect(await screen.findByText("停止中")).toBeTruthy();
    expect(screen.getByRole("button", { name: "新規録画の受付を再開する" })).toBeTruthy();
  });

  it("月間上限額を変更して保存できる", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    mocked.updateAdminSettings.mockResolvedValue({ ...baseResponse, monthlyCostLimitUsd: 80 });
    renderPage();

    const input = await screen.findByDisplayValue("50");
    fireEvent.change(input, { target: { value: "80" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(mocked.updateAdminSettings).toHaveBeenCalledWith("token", {
        monthlyCostLimitUsd: 80,
      });
    });
  });

  it("上限額が現在値と同じままなら保存ボタンは無効", async () => {
    renderPage();

    await screen.findByDisplayValue("50");
    expect(
      (screen.getByRole("button", { name: "保存" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("上限到達時はコストガードの状態を注記する", async () => {
    mocked.fetchAdminSettings.mockResolvedValue({
      ...baseResponse,
      currentMonthCostUsd: 50,
      costLimitReached: true,
    });
    renderPage();

    expect(await screen.findByText(/上限到達・受付停止中/)).toBeTruthy();
  });
});
