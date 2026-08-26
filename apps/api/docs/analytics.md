# 計測（アナリティクス、`POST /beacon`）

Cookie無しのサーバーサイド計測（Issue #142・#144）の参照仕様。`apps/api/README.md` §13
から分割してある。収集する情報を増やす・訪問者を横断して繋げる識別子を持たせる等の
変更は、必ず[`docs/decisions/0024`](../../../docs/decisions/0024-cookieless-analytics-beacon.md)
の「あえて集めないもの」と
[`docs/decisions/0026`](../../../docs/decisions/0026-hashed-visitor-id-daily-salt.md)
を確認してから行うこと。

Cookie/localStorageを一切使わないサーバーサイド計測。フロントエンドから送られる
`AnalyticsEventInput`（`@sattori/shared`。pageview/parse_errorの2種類）を受け、
`analytics.ts`の`recordAnalyticsEvent()`が生IP・生User-Agentを含まない形へ正規化
してから`AnalyticsEventsTable`（DynamoDB、PK=eventDate/SK=eventId、TTL 180日）へ
書き込む。

- `CloudFront-Viewer-Country`ヘッダーから国を得るが、これは`/beacon`ビヘイビアだけ
  CloudFrontを前段に置いているため付与される（`infra/README.md`参照）。ヘッダーが
  無い（＝直接HTTP APIを叩かれた）場合も`country: null`で記録するだけで、リクエスト
  自体は失敗させない。
- User-Agentは`userAgent.ts`の`classifyUserAgent()`でブラウザ/OSの粗いカテゴリへ
  正規化する（バージョンは保持しない）。ビューポート幅・`document.referrer`の丸め方
  はフロントエンド側（`apps/web/README.md`）と合わせて
  [`docs/decisions/0024`](../../../docs/decisions/0024-cookieless-analytics-beacon.md)
  にまとめてある。
- **ユニーク訪問者数算出用に`visitorHash`を記録する**（Issue #144）。
  `analytics.ts`の`extractClientIp()`がクライアントIPを推定し（CloudFront経由
  なら`X-Forwarded-For`の先頭値、直接叩かれた場合はAPI Gatewayの`sourceIp`）、
  `analyticsSalt.ts`の`getOrCreateDailySalt()`が取得・生成した日次saltで
  `hashVisitorId()`がハッシュ化する。生IPは保存しない。設計の詳細は
  [`docs/decisions/0026`](../../../docs/decisions/0026-hashed-visitor-id-daily-salt.md)。
- **`RecordAnalyticsEventFn`は`commonEnv`を使わない**（`loadAnalyticsConfig()`が
  `ANALYTICS_EVENTS_TABLE`・`SETTINGS_TABLE`のみを読む）。`admin/authorizer.ts`・
  `admin/getLogs.ts`と同じく、計測用テーブルとsalt保管用の`SettingsTable`の
  読み書きしか行わないため（`apps/api/README.md` §12）。
- 計測の失敗（DynamoDB書き込みエラー等）はユーザー体験に影響させないため、常に
  202を返す（呼び出し側は`navigator.sendBeacon`でレスポンスを見ない）。

集計（`GET /admin/analytics`、Issue #149）は`adminAnalytics.ts`が日付ごとにQueryして
行う（Scanの`adminCosts.ts`とは違う）。詳細は
[`docs/decisions/0029`](../../../docs/decisions/0029-analytics-aggregation-daily-only-uniques.md)。
