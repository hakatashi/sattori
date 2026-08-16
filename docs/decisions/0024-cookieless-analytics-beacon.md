# 0024. アナリティクスはCookie無しの自前ビーコンで実装し、国はCloudFront経由で取る

- **状態**: 有効
- **決定日**: 2026-08-16
- **対象**: apps/web / apps/api / packages/shared / infra
- **関連**: Issue #142

Cookie/localStorageを一切使わない前提を崩さずに訪問者計測を導入する。自前の
`POST /beacon`エンドポイントへ計測イベントを送り、DynamoDBへ生イベントとして
記録する。生IP・生User-Agent・訪問者を横断して繋げる識別子は保存しない。
`/beacon`だけは例外的にCloudFront(WebCdn)を前段に置き、`CloudFront-Viewer-Country`
ヘッダーから国を得る。

## 背景

Sattoriは「Cookie等を一切使わない」という状態を維持したまま訪問者アナリティクスを
導入したい、という要望から始まった。既存のAPIはCloudFrontを経由せずHTTP APIを
直接叩く構成（`apps/web/README.md`「APIクライアント」）で、CloudFront-Viewer-Country
のようなCloudFront固有ヘッダーは元々どこにも届いていなかった。

## 決定

- **収集する情報**は次の2カテゴリに限定する（`packages/shared/src/analytics.ts`の
  `AnalyticsEventInput`）。
  - HTTPヘッダー由来: `CloudFront-Viewer-Country`（国）、`Accept-Language`
    （主言語タグのみ、`primaryLanguageTag()`）
  - クライアントJSから送る情報: `document.referrer`（サーバー側でホスト名のみに
    丸める、`extractReferrerHost()`）、`utm_source`/`utm_medium`/`utm_campaign`、
    ページパス（UUIDセグメントは`:id`に正規化、`apps/web/src/api/analytics.ts`の
    `normalizePath()`）、ビューポート幅（サーバー側でmobile/tablet/desktopへ丸める、
    `classifyDeviceCategory()`）、User-Agent（サーバー側でブラウザ/OSの粗い
    カテゴリへ正規化、`apps/api/src/userAgent.ts`）
  - 加えて、リプレイのパースエラー発生率（`ReplayParseFailureCode`、
    `unsupported_game`の場合は検出タイトルも）
- **`POST /beacon`（`apps/api/src/handlers/recordAnalyticsEvent.ts`）**が
  `AnalyticsEventsTable`（DynamoDB、PK=eventDate/SK=eventId、TTL 180日）へ書き込む。
  計測の失敗はユーザー体験に影響させないため、書き込み失敗時も200系を返す。
- **`/beacon`だけWebCdn(CloudFront)を前段に置く**（`infra/lib/sattori-stack.ts`の
  `webDistribution.additionalBehaviors["/beacon"]`）。オリジンリクエストポリシー
  `ALL_VIEWER_EXCEPT_HOST_HEADER`で`CloudFront-Viewer-Country`を含むCloudFront
  固有ヘッダーをオリジン（HTTP API）へ転送する。**`ALL_VIEWER_AND_CLOUDFRONT_2022`は
  使わない** —— viewerのHostヘッダー（カスタムドメイン）をそのままオリジンへ転送して
  しまい、API Gatewayがオリジン自身のドメインと不一致として403 Forbiddenを返す
  （Issue #151で発覚）。`ALL_VIEWER_EXCEPT_HOST_HEADER`はHostヘッダーだけを除外しつつ
  CloudFront-Viewer-Countryは引き続き転送するため、API Gateway/Lambda Function URL
  オリジン向けにAWSが用意した組み合わせになる。キャッシュは`CACHING_DISABLED`
  （計測イベントは1件ごとに内容が違うため）。フロントエンド
  （`apps/web/src/api/analytics.ts`）は`API_BASE`を経由せず常に相対パス`/beacon`
  で叩く——本番では現在ページと同一オリジン（WebCdnのカスタムドメイン）に解決される
  必要があるため。
- **jobIdのようなURL中の秘密値（[`0004`](0004-job-id-as-authorization-secret.md)）は
  記録しない**。`normalizePath()`がUUID形式のセグメントを`:id`に置き換えてから送る。

## 根拠

- **Plausibleの手法（Cookie無し・IPを日次saltでハッシュ化してユニーク判定）を
  参考にしたが、今回は訪問者の一意性判定自体をスコープ外にした**。ユーザーから
  求められたのは「属性ごとの記録」であり、ユニーク訪問者数の算出は含まれていない
  （会話ログ）。スコープを絞ることで、IPハッシュ用のsalt管理・ローテーションという
  余分な実装を避けられる。
- **CloudFrontアクセスログ→Athena集計案（会話で検討した案1）は不採用**。
  SPAのため実際のPVリクエストが静的アセット取得としてしか記録されず、
  React Router側のルート遷移（ページ単位のPV）が拾えないため。
- **Plausibleセルフホストは不採用**。Postgres/ClickHouseの常時稼働リソースが
  必要になり、「ウェブ基盤はAWSフルサーバーレスに統一」（`AGENTS.md` §3）という
  既定方針と衝突する。
- **`/beacon`だけCloudFrontを前段に置く判断**: `CloudFront-Viewer-Country`は
  CloudFrontを経由したリクエストにしか付与されない。IPからGeoIP変換する外部
  サービス呼び出しやMaxMind等のデータセット同梱は、外部依存・追加コスト・
  「生IPを扱う経路が増える」という点でCloudFront経由より劣ると判断した。
- **UAは家系のみ保持しバージョンは捨てる**。ブラウザメジャーバージョンまで
  保持すると、他の粗い属性（OS・デバイスカテゴリ・国）と組み合わせたときの
  識別性が上がり、「訪問者を横断して繋げる識別子は持たない」という前提が
  実質的に崩れるため。

## 採らなかった選択肢

- **IPを日次saltでハッシュ化したユニーク訪問者ID**: Plausible本来の手法だが、
  今回のスコープ外（上記）。将来必要になれば別Issueで検討する。
- **CloudFrontアクセスログ + Athena**（案1）: SPAのルート単位PVが取れないため。
- **Plausibleセルフホスト / Plausible Cloud契約**: 前者はAWSフルサーバーレス方針と
  衝突、後者は外部SaaSへの送信になり月間1000録画規模のコスト感に対して過剰。
- **UAの生文字列・ブラウザメジャーバージョンまでの保存**: フィンガープリンティング
  の温床になるため、家系のみに丸めた。
- **管理画面への集計表示を同時に作る**: 今回はユーザーから「まず記録したい」という
  要望のみで、可視化はスコープ外とした（Issue #142）。

## 影響範囲

- `packages/shared/src/analytics.ts`（`AnalyticsEventInput`契約）、
  `packages/shared/src/replay.ts`（`ReplayParseFailure.game`の追加）
- `apps/api/src/analytics.ts` / `userAgent.ts` /
  `handlers/recordAnalyticsEvent.ts` / `config.ts`
- `apps/web/src/api/analytics.ts` / `hooks/useAnalyticsPageview.ts` /
  `App.tsx`（`Layout`）/ `components/UploadForm.tsx` / `vite.config.ts`
- `infra/lib/sattori-stack.ts`（`AnalyticsEventsTable`・`RecordAnalyticsEventFn`・
  `POST /beacon`ルート・`webDistribution`の`/beacon`ビヘイビア）
- この設計を変える場合、特に「収集する情報を増やす」変更は上記の「あえて集めない
  もの」の一線を越えていないか、必ずこのファイルを読んでから判断すること。
