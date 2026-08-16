import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { trackPageview } from "../api/analytics.ts";

/**
 * ルート変更（初回マウント含む）ごとにpageviewビーコンを送る（Issue #142）。
 * `Layout`（`App.tsx`）でのみ呼ぶこと——`/admin/*`は別コンポーネントツリー
 * （`AdminApp`）でこのフックを使わないため、自然に計測対象から外れる。
 */
export function useAnalyticsPageview(): void {
  const location = useLocation();
  useEffect(() => {
    trackPageview(location.pathname);
  }, [location.pathname]);
}
