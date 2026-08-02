import { useCallback, useMemo, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { AdminAuthContext } from "./AdminAuthContext.ts";
import { CostCurrencyContext, loadCostCurrency, saveCostCurrency } from "./adminCurrency.ts";
import type { CostCurrency } from "./adminCurrency.ts";
import { AdminLayout } from "./AdminLayout.tsx";
import { AdminLogin } from "./AdminLogin.tsx";
import { clearAdminToken, loadAdminToken, saveAdminToken } from "./adminToken.ts";
import { JobListPage } from "./JobListPage.tsx";
import { JobDetailPage } from "./JobDetailPage.tsx";
import { CostsPage } from "./CostsPage.tsx";

/**
 * 管理画面(`/admin`, Issue #51)のルート。`../App.tsx`から`React.lazy`で遅延ロードされる。
 * トークンをlocalStorageで保持し、未ログイン時はログインフォームのみを描画する
 * （認可はAPI Gateway側のLambda Authorizerが本体、ここでのゲートはUX目的）。
 * 401/403を受けた画面は`AdminAuthContext.onUnauthorized`経由でここに戻ってきて
 * トークンをクリアし、再ログインを促す。
 */
export function AdminApp() {
  const [token, setToken] = useState<string | null>(() => loadAdminToken());
  const [invalidTokenNotice, setInvalidTokenNotice] = useState(false);
  const [currency, setCurrencyState] = useState<CostCurrency>(() => loadCostCurrency());

  const setCurrency = useCallback((next: CostCurrency) => {
    saveCostCurrency(next);
    setCurrencyState(next);
  }, []);
  const currencyValue = useMemo(() => ({ currency, setCurrency }), [currency, setCurrency]);

  function handleLogin(next: string) {
    saveAdminToken(next);
    setInvalidTokenNotice(false);
    setToken(next);
  }

  function handleUnauthorized() {
    clearAdminToken();
    setInvalidTokenNotice(true);
    setToken(null);
  }

  function handleLogout() {
    clearAdminToken();
    setInvalidTokenNotice(false);
    setToken(null);
  }

  if (!token) {
    return <AdminLogin onLogin={handleLogin} invalidTokenNotice={invalidTokenNotice} />;
  }

  return (
    <AdminAuthContext.Provider value={{ token, onUnauthorized: handleUnauthorized }}>
      <CostCurrencyContext.Provider value={currencyValue}>
        <AdminLayout onLogout={handleLogout}>
          <Routes>
            <Route index element={<JobListPage />} />
            <Route path="jobs/:jobId" element={<JobDetailPage />} />
            <Route path="costs" element={<CostsPage />} />
            <Route path="*" element={<Navigate to="/admin" replace />} />
          </Routes>
        </AdminLayout>
      </CostCurrencyContext.Provider>
    </AdminAuthContext.Provider>
  );
}
