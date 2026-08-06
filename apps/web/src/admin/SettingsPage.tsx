import { useEffect, useState } from "react";
import { DEFAULT_MONTHLY_COST_LIMIT_USD } from "@sattori/shared";
import { AdminUnauthorizedError, fetchAdminSettings, updateAdminSettings } from "./adminApi.ts";
import { useAdminAuth } from "./AdminAuthContext.ts";
import { useCostCurrency } from "./adminCurrency.ts";
import { formatMoney } from "./costFormat.ts";
import { useAdminResource } from "./useAdminResource.ts";
import styles from "./SettingsPage.module.css";

/**
 * 運用設定画面（`/admin/settings`、Issue #14）。
 *
 * - **キルスイッチ**: `acceptingNewJobs`。falseにすると`POST /magic-links`が
 *   即座に503（`service_paused`）を返すようになる（`requestMagicLink.ts`は
 *   このフラグをキャッシュせず毎回参照するため、切替は次のリクエストから反映される）。
 *   月間コストガードが発動する前に運用者が手動で全面停止できるようにする機能。
 * - **月間コストガード**: `monthlyCostLimitUsd`。当月の推定コスト（既存の
 *   コスト推定機能、Issue #60）がこの金額に達すると、キルスイッチと同じ503応答で
 *   新規受付を止める。回数ではなく金額で判定するのは、自宅サーバーを追加ワーカーと
 *   する構想（Issue #49）でジョブ単価が一様でなくなる見込みのため。
 *
 * どちらもユーザー向けのサービス提供可否に直結する変更のため、保存前に
 * `window.confirm`で確認する（`JobActionsPanel`と同じ方針）。
 */
export function SettingsPage() {
  const { token, onUnauthorized } = useAdminAuth();
  const { currency } = useCostCurrency();
  const { data, loading, error, reload } = useAdminResource((t) => fetchAdminSettings(t), []);

  const [limitInput, setLimitInput] = useState("");
  const [saving, setSaving] = useState<"killSwitch" | "limit" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // サーバー側の値が届いたら入力欄を初期化する（再取得のたびに上書きされないよう、
  // ユーザーが編集中の値は`data`が変わらない限り保持する）。
  useEffect(() => {
    if (data) {
      setLimitInput(String(data.monthlyCostLimitUsd));
    }
  }, [data?.monthlyCostLimitUsd]);

  if (loading && !data) {
    return <p className={styles.muted}>読み込み中…</p>;
  }
  if (error) {
    return <p className={styles.error}>{error}</p>;
  }
  if (!data) {
    return null;
  }

  const handleToggleKillSwitch = () => {
    const next = !data.acceptingNewJobs;
    const confirmed = window.confirm(
      next
        ? "新規録画の受付を再開します。よろしいですか？"
        : "新規録画の受付を停止します。既に受付済み・実行中のジョブには影響しませんが、以降のマジックリンク要求はすべて拒否されます。よろしいですか？",
    );
    if (!confirmed) {
      return;
    }
    setSaving("killSwitch");
    setActionError(null);
    updateAdminSettings(token, { acceptingNewJobs: next })
      .then(() => reload())
      .catch((err: unknown) => {
        if (err instanceof AdminUnauthorizedError) {
          onUnauthorized();
          return;
        }
        setActionError(err instanceof Error ? err.message : "不明なエラーが発生しました");
      })
      .finally(() => setSaving(null));
  };

  const handleSaveLimit = () => {
    const parsed = Number(limitInput);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setActionError("月間上限額は正の数値で入力してください");
      return;
    }
    const confirmed = window.confirm(
      `月間コストガードの上限額を ${formatMoney(parsed, "usd", 2)} に変更します。よろしいですか？`,
    );
    if (!confirmed) {
      return;
    }
    setSaving("limit");
    setActionError(null);
    updateAdminSettings(token, { monthlyCostLimitUsd: parsed })
      .then(() => reload())
      .catch((err: unknown) => {
        if (err instanceof AdminUnauthorizedError) {
          onUnauthorized();
          return;
        }
        setActionError(err instanceof Error ? err.message : "不明なエラーが発生しました");
      })
      .finally(() => setSaving(null));
  };

  const ratio = Math.min(1, data.currentMonthCostUsd / data.monthlyCostLimitUsd);

  return (
    <section>
      <div className={styles.card}>
        <h2 className={styles.cardHeading}>キルスイッチ</h2>
        <p className={styles.cardNote}>
          新規録画の受付（マジックリンク送信要求）を手動で即座に停止・再開します。
          月間コストガードが発動する前に、運用者が緊急停止する用途を想定しています。
          既に受付済み・実行中のジョブには影響しません。
        </p>
        <p className={styles.status}>
          現在の状態:{" "}
          <span className={data.acceptingNewJobs ? styles.statusOk : styles.statusStopped}>
            {data.acceptingNewJobs ? "受付中" : "停止中"}
          </span>
        </p>
        <button
          type="button"
          className={`${styles.button} ${data.acceptingNewJobs ? styles.stopButton : ""}`}
          onClick={handleToggleKillSwitch}
          disabled={saving !== null}
        >
          {saving === "killSwitch"
            ? "更新中…"
            : data.acceptingNewJobs
              ? "新規録画の受付を停止する"
              : "新規録画の受付を再開する"}
        </button>
      </div>

      <div className={styles.card}>
        <h2 className={styles.cardHeading}>月間コストガード</h2>
        <p className={styles.cardNote}>
          当月（UTC基準）の推定コスト合計（コスト集計ページと同じ推定値、請求額そのもの
          ではありません）が下記の上限額に達すると、新規録画の受付をキルスイッチと同様に
          自動停止します。翌月になると自動的に再開します。
        </p>
        <p className={styles.status}>
          当月の推定コスト: {formatMoney(data.currentMonthCostUsd, currency, 2)} /{" "}
          {formatMoney(data.monthlyCostLimitUsd, currency, 2)}
          {data.costLimitReached && <span className={styles.statusStopped}>（上限到達・受付停止中）</span>}
        </p>
        <span className={styles.gauge}>
          <span
            className={data.costLimitReached ? styles.gaugeOver : styles.gaugeFill}
            style={{ width: `${ratio * 100}%` }}
          />
        </span>
        <div className={styles.limitRow}>
          <label className={styles.limitLabel}>
            上限額 (USD):{" "}
            <input
              className={styles.limitInput}
              type="number"
              min="0"
              step="1"
              value={limitInput}
              onChange={(event) => setLimitInput(event.target.value)}
            />
          </label>
          <button
            type="button"
            className={styles.button}
            onClick={handleSaveLimit}
            disabled={saving !== null || String(data.monthlyCostLimitUsd) === limitInput}
          >
            {saving === "limit" ? "更新中…" : "保存"}
          </button>
        </div>
        <p className={styles.cardNote}>既定値は ${DEFAULT_MONTHLY_COST_LIMIT_USD} です。</p>
      </div>

      {actionError && <p className={styles.error}>{actionError}</p>}
    </section>
  );
}
