import { useCallback, useEffect, useRef, useState } from "react";
import { AdminUnauthorizedError } from "./adminApi.ts";
import { useAdminAuth } from "./AdminAuthContext.ts";

interface AdminResourceState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

interface AdminResource<T> extends AdminResourceState<T> {
  /**
   * 同じリソースを取り直す（ジョブの停止・再実行など、画面から状態を変えた直後に
   * 最新のジョブレコードを反映させるため。Issue #59）。deps変更時と違い、
   * 取得中も直前の`data`を保持したままにする（操作パネルが一瞬アンマウントされて
   * 実行結果のメッセージが消えるのを避けるため）。
   */
  reload: () => void;
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
): AdminResource<T> {
  const { token, onUnauthorized } = useAdminAuth();
  const [state, setState] = useState<AdminResourceState<T>>({
    data: null,
    loading: true,
    error: null,
  });
  const [reloadCount, setReloadCount] = useState(0);
  // この実行が`reload()`起因か（＝取得中も既存dataを残してよいか）を伝える。
  // deps変更（別ジョブへの遷移など）では別リソースの内容が残らないようクリアする。
  const isReloadRef = useRef(false);

  const reload = useCallback(() => {
    isReloadRef.current = true;
    setReloadCount((count) => count + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const keepData = isReloadRef.current;
    isReloadRef.current = false;
    setState((prev) => ({ data: keepData ? prev.data : null, loading: true, error: null }));

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
  }, [...deps, reloadCount]);

  return { ...state, reload };
}
