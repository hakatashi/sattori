# 0022. 新規受付の自動停止は録画回数ではなく推定コスト額で判定する

- **状態**: 有効
- **決定日**: 2026-07
- **対象**: apps/api
- **関連**: Issue #14、Issue #49、Issue #60

無料サービスの暴走を止める月間ガード（`costGuard.ts`）は、月間の録画**回数**ではなく
**当月の推定コスト合計**（`estimateJobCost()`、既定50 USD）で判定する。判定値は
`JobsTable` の全件 Scan を要するため、ユーザー向け経路では5分キャッシュする。
**閾値到達直後の数分は数件超過して受け付ける**が、これは意図した割り切りである。

## 背景

Sattori は無料で公開するため、濫用や想定外の人気で青天井に課金されることを防ぐ必要が
ある（Issue #14）。素直な実装は「月N回まで」という回数上限である。

しかしジョブ1件あたりのコストは一様ではない。タイトルによってインスタンスタイプが
`.xlarge`〜`.4xlarge` と4倍の幅があり（[`0016`](0016-ec2-fleet-instance-type-diversification.md)）、
さらに自宅ワーカー（Issue #49）へ流れたジョブは EC2 課金が発生しない
（[`0018`](0018-home-worker-pull-assignment.md)）。

## 決定

- 判定は `AdminSettings.monthlyCostLimitUsd`（既定 `DEFAULT_MONTHLY_COST_LIMIT_USD`
  ＝50 USD）に対する**当月の推定コスト合計**で行う
  （`adminCosts.ts` の `estimateCurrentMonthCostUsd()`）。
- 全件 Scan が要るため、ユーザー向け経路専用の `costGuard.ts` が5分
  （`COST_GUARD_CACHE_TTL_MS`）Lambda 実行コンテキストにキャッシュする
  （`adminAuth.ts` の SSM トークンキャッシュと同じ考え方）。
- 併せて、運用者が手で即座に止められる**キルスイッチ**（`acceptingNewJobs`）を持つ。
  こちらはキャッシュせず毎回 GetItem するので次のリクエストから反映される。

## 根拠

- **回数では上限の意味が保てない**。th20 の `.4xlarge` ばかり1000件と、自宅ワーカーで
  処理された1000件では実際の請求が桁違いになる。守りたいのは請求額であって回数ではない。
- **キャッシュの数分ぶんの超過は許容できる**。この判定に使う値はそもそも推定値であって
  請求額そのものではない（`AGENTS.md` §3）。数件ぶんの誤差のために、ユーザー向けの
  `POST /magic-links` すべてに全件 Scan を負わせるほうが割に合わない。
- キルスイッチを別に持つのは、**自動ガードが働く前に人間が止めたい**場面
  （攻撃を受けている、想定外の挙動を見つけた）があるため。

## 採らなかった選択肢

- **月間の録画回数で上限を設ける**。上記のとおりジョブ単価が一様でない。
- **キャッシュせず毎回集計する**。全件 Scan がユーザー向けのクリティカルパスに乗る。
- **集計結果テーブルを持つ / 分析基盤を入れる**。想定規模は月1000ジョブで、1年運用しても
  1万件強にしかならない。「増えたら考える」ほうが総コストが低い
  （[`apps/api/docs/admin-api.md`](../../apps/api/docs/admin-api.md) §9 と同じ判断）。

## 影響範囲

- `apps/api/src/costGuard.ts` / `settings.ts` / `adminCosts.ts`
- `apps/api/src/handlers/requestMagicLink.ts`（レート制限より前に判定する）
- `apps/web/src/admin/SettingsPage.tsx`（閾値と当月推定コストの表示。
  [`apps/web/docs/admin-ui.md`](../../apps/web/docs/admin-ui.md)）
- 単価定数（`packages/shared/src/cost.ts`）を変えると発動タイミングも変わる
