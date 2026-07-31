import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { AdminApp } from "./AdminApp.tsx";
import { clearAdminToken, loadAdminToken } from "./adminToken.ts";
import * as adminApi from "./adminApi.ts";

vi.mock("./adminApi.ts", () => ({
  AdminUnauthorizedError: class extends Error {},
  fetchAdminJobs: vi.fn(),
  fetchAdminJobDetail: vi.fn(),
  fetchAdminExecution: vi.fn(),
}));

const mocked = vi.mocked(adminApi);

// AdminApp内部の<Routes>はindex="/admin"を基準にした相対パスでマッチするため、
// 実際のApp.tsxと同様に`<Route path="/admin/*">`配下にネストして描画する
// （直接トップレベルに置くと"/admin"が"index"にマッチせず"*"の無限ループになる）。
function renderAdminApp(initialPath = "/admin") {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/admin/*" element={<AdminApp />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("AdminApp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearAdminToken();
    mocked.fetchAdminJobs.mockResolvedValue({ items: [], nextCursor: null });
  });

  afterEach(() => {
    clearAdminToken();
  });

  it("トークン未設定時はログインフォームを表示する", () => {
    renderAdminApp();
    expect(screen.getByPlaceholderText("トークン")).toBeTruthy();
  });

  it("トークンを入力して送信すると一覧が描画され、localStorageに保存される", async () => {
    renderAdminApp();

    const input = screen.getByPlaceholderText("トークン");
    fireEvent.change(input, { target: { value: "my-secret-token" } });
    fireEvent.click(screen.getByText("ログイン"));

    await waitFor(() => expect(mocked.fetchAdminJobs).toHaveBeenCalled());
    expect(loadAdminToken()).toBe("my-secret-token");
    expect(screen.getByText("ログアウト")).toBeTruthy();
  });

  it("APIがAdminUnauthorizedErrorを投げたらログイン画面へ戻り、localStorageがクリアされる", async () => {
    mocked.fetchAdminJobs.mockRejectedValue(new adminApi.AdminUnauthorizedError("invalid token"));
    renderAdminApp();

    const input = screen.getByPlaceholderText("トークン");
    fireEvent.change(input, { target: { value: "wrong-token" } });
    fireEvent.click(screen.getByText("ログイン"));

    await waitFor(() => expect(screen.getByPlaceholderText("トークン")).toBeTruthy());
    expect(loadAdminToken()).toBeNull();
    expect(screen.getByText("トークンが無効です。再入力してください。")).toBeTruthy();
  });
});
