# キルスイッチ・月間コストガード（`settings.ts`, `costGuard.ts`, Issue #14／#130）

新規録画の受付をグローバルに止める2つの仕組みの参照仕様。`apps/api/README.md` §9から
分割してある。月間コストガードの判定基準・キャッシュの割り切りは
[`docs/decisions/0022`](../../../docs/decisions/0022-cost-guard-by-estimated-amount-not-job-count.md)、
`requestMagicLink`と`startJob`でチェック内容が非対称な理由は
[`docs/decisions/0033`](../../../docs/decisions/0033-admission-control-split-magic-link-vs-start-job.md)
を参照。

`requestMagicLink.ts`はメールレート制限より前に、以下2つのグローバルな受付制御を
順に行う。どちらも`SettingsTable`（PK固定値1件のシングルトン設定、
`SETTINGS_KEY = "global"`）に持つ`AdminSettings`を参照する。

- **キルスイッチ**（`acceptingNewJobs`）: 管理画面（`/admin/settings`）から手動で
  新規録画の受付を即座に停止できる。`getSettings()`はキャッシュせず毎回GetItemする
  ため、切替は次のリクエストから反映される。
- **月間コストガード**（`monthlyCostLimitUsd`、既定`DEFAULT_MONTHLY_COST_LIMIT_USD`
  ＝50 USD）: 当月の推定コスト合計（`adminCosts.ts`の`estimateCurrentMonthCostUsd()`）
  が閾値に達したら新規受付を止める。全件Scanを要するため、ユーザー向け経路専用の
  `costGuard.ts`が5分（`COST_GUARD_CACHE_TTL_MS`）キャッシュする。
- どちらも該当すれば`POST /magic-links`は503（`service_paused` /
  `monthly_cost_limit_reached`）を返す。エラーメッセージはそのままフロントエンドに
  表示される（`apps/web`はAPIの`ApiError.message`をそのままユーザーに見せる設計）。
- **キルスイッチは`startJob.ts`（`POST /jobs/{jobId}/start`）でも確認するが、月間
  コストガードはここでは見ていない**。`startJobFn`が`pending`→`queued`の原子遷移
  （`startPendingJob()`）を行う**前**に`getSettings()`を確認し、停止中はジョブを
  `pending`のまま据え置いて503（`service_paused`）を返す。
- 設定の更新（`POST /admin/settings`）は`settings.ts`の`updateSettings()`が単純な
  読み取り→マージ→上書きで行う。管理者は1人固定で更新頻度も低いため、
  `rateLimit.ts`のような原子的な条件付き更新は採用していない。
