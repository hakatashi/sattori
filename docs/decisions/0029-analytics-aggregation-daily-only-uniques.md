# 0029. 訪問者アナリティクスの集計はパーティション単位のQueryで行い、ユニーク訪問者数は日次のみ意味を持たせる

- **状態**: 有効
- **決定日**: 2026-08-25
- **対象**: apps/api / packages/shared / apps/web / infra
- **関連**: Issue #149、Issue #144（PR #150）、Issue #142、
  [`docs/decisions/0024`](0024-cookieless-analytics-beacon.md)、
  [`docs/decisions/0026`](0026-hashed-visitor-id-daily-salt.md)

管理画面の集計エンドポイント（`GET /admin/analytics`）は、`AnalyticsEventsTable`が
PK=eventDateであることを利用して**日付ごとにDynamoDB Queryを発行し、アプリ側で
集計する**（`JobsTable`の全件Scanで集計する`adminCosts.ts`とは異なる方式）。また、
複数日にまたがる「ユニーク訪問者数」はハッシュ化訪問者IDのsaltが日次ローテーション
のため**原理的に算出できない**ので、レスポンスの型・フィールド名・画面表示のすべてで
「日別の値の単純合計」であることを明示し、期間全体の実訪問者数であるかのように
誤読されないようにする。

## 背景

Issue #144（PR #150）で`visitorHash`（IPを日次saltでハッシュ化した仮の訪問者ID）を
`AnalyticsEventsTable`へ記録するところまでは実装したが、集計・可視化は意図的に
スコープ外にした（[`docs/decisions/0026`](0026-hashed-visitor-id-daily-salt.md)
「採らなかった選択肢」）。本Issueはその可視化部分。ユーザーからは「ユニーク訪問者数
だけでなくpageview数等の他の指標も見たい」という要望があった。

## 決定

- **集計方式はオンデマンド + アプリ側集計**（`adminCosts.ts`と同じく、専用の集計
  バッチ・別テーブルへの事前集計は導入しない）。ただし取得方法は`adminCosts.ts`
  （`JobsTable`の全件Scan）と異なり、`AnalyticsEventsTable`はPK=eventDateなので
  **集計対象の日付ぶんだけQueryを発行する**（`apps/api/src/adminAnalytics.ts`の
  `summarizeAnalytics()`）。日付間に依存が無いため`Promise.all`で並行に投げる。
- 集計期間は既定30日・上限90日（`ADMIN_ANALYTICS_DEFAULT_DAYS`/
  `ADMIN_ANALYTICS_MAX_DAYS`、`packages/shared/src/admin.ts`）。上限は
  `AnalyticsEventsTable`のTTL（180日）より十分小さく、1リクエストで発行する
  Query数（＝Lambda実行時間・メモリ）を抑えるために設けた。
- **ユニーク訪問者数は日単位でしか意味を持たない**ため、粒度を「日次のみ」にした
  （`adminCosts.ts`のような日次/週次/月次の切り替えは提供しない）。複数日を選んだ
  ときの合計値は`totals.uniqueVisitorDays`という名前で返す——`uniqueVisitors`にせず
  あえて`uniqueVisitorDays`にしているのは、「日別ユニーク数の単純合計」であって
  期間内の実訪問者数（日をまたいだ重複を除いた数）ではないことをAPI契約の時点で
  誤読しにくくするため。管理画面（`AnalyticsPage.tsx`）でもラベルに
  「（日別合計）」を明記し、注記でも同じ制約を繰り返す。
- 属性別の内訳（ページ・参照元・国・言語・デバイス・ブラウザ/OS・UTM流入元・
  パースエラー種別・検出タイトル）は、件数の多い順に上位10件
  （`ADMIN_ANALYTICS_BREAKDOWN_LIMIT`）だけ返す。ロングテールを全部返しても運用上
  読まれないため。

## 根拠

- **Queryベースの集計（Scanではない）**: `AnalyticsEventsTable`のアクセスパターンは
  「特定の日の全イベント」であり、PKがそのままeventDateなので`KeyConditionExpression`
  だけで絞り込める。Scanと違って読み取り対象がリクエストされた期間に厳密に一致する
  ため、`adminCosts.ts`より効率が良い（`JobsTable`がScanなのはPKがjobIdでGSIも
  ステータス単位のため、期間クエリに使えないという別の制約による。両者は
  「素朴な方式で十分」という判断は共通するが、採れる素朴さの中身が違う）。
- **バッチ集計・別テーブルへの事前集計は不採用**: 月間最大1000録画規模のトラフィック
  （`AGENTS.md` §1）では、90日ぶんのQueryを並行発行しても実用的な時間で終わる
  （`AdminGetCostsFn`と同じタイムアウト・メモリ設定で足りると判断）。EventBridge
  定期実行や集計専用DynamoDBテーブルは、この規模では明確に過剰
  （`adminCosts.ts`と同じ「増えたら考える」判断、Issue #60の設計メモ）。
- **粒度を日次のみにした**: saltが日次ローテーションである以上（`docs/decisions/0026`）、
  「週次ユニーク訪問者数」を素朴に「その週の`visitorHash`のユニーク件数」として
  実装すると、実態は「週内の日別ユニーク数の単純合計」でしかないのに、コスト集計の
  週次/月次バケットと同じ見た目で並ぶと「ちゃんと重複排除された値」だと誤読される
  リスクが高い。単位を日次に絞り、複数日の合計には別名（`uniqueVisitorDays`）を
  与えることで、この誤読を型・API契約・画面表示の3箇所で防ぐほうが安全と判断した。
- **内訳を上位10件に絞った**: 全件返すと特にページパス・参照元でロングテールが
  大半を占め、画面が長くなるだけで運用上の意思決定に寄与しない。コスト集計の
  バケット上限（`ADMIN_COST_BUCKET_MAX_LIMIT`）のような「必要なら増やせる」余地は
  クエリパラメータではなく定数固定にした——内訳はページ本体の集計対象日数
  （`days`）を変えれば自然に変わるため、内訳自体に別のページングUIを足す必要性が
  薄いという判断。

## 採らなかった選択肢

- **週次/月次のユニーク訪問者数を「重複排除された値」として提供する**: 上記
  「粒度を日次のみにした」参照。saltの日次ローテーションと根本的に矛盾する。
  将来的に本当に必要になった場合は、salt自体の設計（`docs/decisions/0026`）を
  変える（例: ローテーション周期を伸ばす）別Issueとして検討すべきで、集計側だけを
  作り込んで誤魔化すべきではない。
- **CloudFrontアクセスログ + Athenaでの集計**: `docs/decisions/0024`で既に不採用
  （SPAのルート単位PVが取れない）。今回の集計対象は`AnalyticsEventsTable`であり
  この問題は最初から発生しない。
- **集計結果を別テーブルへ事前計算しておく（EventBridge定期実行等）**: 上記
  「根拠」参照。現状の規模ではオンデマンド集計で十分に速く、事前計算は運用対象
  （バッチの失敗監視・再実行）を増やすだけ。
- **内訳をクエリパラメータで可変件数にする**: 運用上10件を超える粒度が必要になった
  実例が無く、可変にする複雑さに見合わないため上位10件で固定した。

## 影響範囲

- `packages/shared/src/admin.ts`（`AdminAnalyticsSummaryResponse`等の契約、
  `ADMIN_ANALYTICS_DEFAULT_DAYS`/`ADMIN_ANALYTICS_MAX_DAYS`/
  `ADMIN_ANALYTICS_BREAKDOWN_LIMIT`）
- `apps/api/src/adminAnalytics.ts`（集計本体）・`handlers/admin/getAnalytics.ts`・
  `config.ts`（`ApiConfig.analyticsEventsTable`）
- `apps/web/src/admin/AnalyticsPage.tsx`・`adminApi.ts`・`AdminApp.tsx`・
  `AdminLayout.tsx`
- `infra/lib/sattori-stack.ts`（`AdminGetAnalyticsFn`、`GET /admin/analytics`
  ルート、`commonEnv`への`ANALYTICS_EVENTS_TABLE`追加）
- 集計対象の指標を増やす（例: セッション概念の導入）場合や、粒度を週次/月次へ
  広げたくなった場合は、必ずこのファイルの「粒度を日次のみにした」の根拠と
  `docs/decisions/0026`を先に読み、saltのローテーション周期側から見直すべきでは
  ないか検討すること。
