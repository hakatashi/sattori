import { useEffect, useState } from "react";
import { AdminUnauthorizedError } from "./adminApi.ts";
import { useAdminAuth } from "./AdminAuthContext.ts";

interface AdminResourceState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

/**
 * 一覧・詳細・実行状態の3画面で使い回す小さなデータ取得フック。
 * `AdminUnauthorizedError`（401/403）を受けたら`onUnauthorized`でログイン画面へ戻す
 * （トークン失効・誤入力からの復帰導線）。`fetcher`は依存配列(deps)が変わるたびに
 * 再実行される。
 */
export function useAdminResource<T>(
  fetcher: (token: string) => Promise<T>,
  deps: unknown[],
): AdminResourceState<T> {
  const { token, onUnauthorized } = useAdminAuth();
  const [state, setState] = useState<AdminResourceState<T>>({
    data: null,
    loading: true,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    setState({ data: null, loading: true, error: null });

    fetcher(token)
      .then((data) => {
        if (!cancelled) {
          setState({ data, loading: false, error: null });
        }
      })
      .catch((err) => {
        if (cancelled) {
          return;
        }
        if (err instanceof AdminUnauthorizedError) {
          onUnauthorized();
          return;
        }
        const message = err instanceof Error ? err.message : "不明なエラーが発生しました";
        setState({ data: null, loading: false, error: message });
      });

    return () => {
      cancelled = true;
    };
    // depsは呼び出し側が明示的に指定する（fetcherの参照そのものは含めない設計のため、
    // 通常のReact Hooksのexhaustive-deps検査とは意図的にズレる）。
  }, deps);

  return state;
}
