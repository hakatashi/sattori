# apps/web

フロントエンド SPA（Vite + React + CSS Modules、`react-router-dom`でクライアント
サイドルーティング）。API契約は `packages/shared/README.md` を参照。**ここには「今どう
なっているか」だけを書く** —— なぜそうしたかの根拠は
[`docs/decisions/`](../../docs/decisions/README.md)、管理画面（`/admin/*`）の詳細は
[`docs/admin-ui.md`](docs/admin-ui.md)、ページAの録画オプションとタイトル別注意書きは
[`docs/upload-form.md`](docs/upload-form.md) にある。

## 目次

- [1. ルーティング（`src/App.tsx`）](#1-ルーティングsrcapptsx)
- [2. ページAのフロー（`components/UploadForm.tsx`）](#2-ページaのフローcomponentsuploadformtsx)
- [3. ページBのフロー（`pages/JobPage.tsx`）](#3-ページbのフローpagesjobpagetsx)
- [4. ダウンロード（`components/JobProgress.tsx`）](#4-ダウンロードcomponentsjobprogresstsx)
- [5. 完了後のプレビュー再生（Issue #71）](#5-完了後のプレビュー再生componentsjobprogresstsxissue-71)
- [6. 多言語対応（i18n、`src/i18n/`）](#6-多言語対応i18nsrci18n)
  - [6.2 sitemap.xml・robots.txt・SPAページのメタ情報動的更新（Issue #214）](#62-sitemapxmlrobotstxtspaページのメタ情報動的更新issue-214)
- [7. APIクライアント（`src/api/client.ts`）](#7-apiクライアントsrcapiclientts)
- [8. 管理画面（`src/admin/`、Issue #51）](#8-管理画面srcadminissue-51)
- [9. 計測（アナリティクス、Issue #142）](#9-計測アナリティクスissue-142)
- [10. 開発サーバ](#10-開発サーバ)
- [11. テスト](#11-テスト)

## 1. ルーティング（`src/App.tsx`）

- `/` = ページA（`HomePage`）: リプレイのアップロード〜マジックリンク送信要求。
- `/jobs/:jobId` = ページB（`JobPage`）: マジックリンクのリンク先。アクセスで自動的に
  録画を起動し、進捗ポーリング・DLボタン表示まで担う。`jobId`のみで認可する
  （メールを確認しないと分からない秘密値。URLに他の認可情報は含まない）。
- 上記2ルートは`/en`配下（`/en`・`/en/jobs/:jobId`）にも同型で存在する（英語版、
  詳細は§6）。未定義パスはそれぞれ`/`・`/en`へリダイレクト。
- `/admin/*` = 管理画面（`src/admin/`、Issue #51）。ja/enどちらのツリーにも属さない
  独立ルートで、日本語固定・i18n非適用。`React.lazy`で別チャンクに分離しているため、
  一般ユーザーのバンドルには含まれない。ja/enツリーの`catch-all(<Route path="*">)`より
  **前**に定義する必要がある（後ろだと`/admin`が`/`へ即リダイレクトされてしまう）。
  詳細は§8。
- 共通レイアウト（ヘッダー・フッター）は`Layout`。ページBはページAより広い画面幅
  （2カラムのリプレイ情報+アクティビティログ）を活かすため、`useMatch`でページBのみ
  最大幅を広げている。
- 開発時は `?preview=replay` / `?preview=job` クエリで、実データ無しに
  `ReplayPreview`/`JobProgress`の見た目を確認できる（`dev/*Playground.tsx`、
  `import.meta.env.DEV`ガードで本番ビルドには含まれない）。

## 2. ページAのフロー（`components/UploadForm.tsx`）

1. ファイル選択で即座に自動実行: 解析（`@sattori/shared`の`parseReplayInfo()`、実体は
   `@sattori/touhou-replay-parser`）とアップロード（`createUpload()`で署名付きURL取得→
   `uploadReplay()`でS3へ直接PUT）を`Promise.all`で並行実行する。`@sattori/touhou-replay-parser`
   はゼロ依存でブラウザでもそのまま動作するため（`packages/replay-parser/README.md`
   参照）、バックエンドの`POST /replays/parse`（S3からの再取得を挟む分のラグが乗る）を
   経由せずブラウザ内で完結させ、アップロード完了を待たずにプレビューを表示できる
   （`POST /replays/parse`自体は同じ解析ロジックのAPIとして残っているが、このフローからは
   呼ばれない）。解析はファイル選択後すぐに終わる一方、アップロードは回線速度に依存する
   ため、解析だけ先に終わってプレビューが表示され、アップロードは裏で続く状態になりうる
   （STEP2の下に「アップロード中…」を表示）。
2. 解析成功で`ReplayPreview`にゲーム名/キャラ/スコア/クリア可否等を表示。
   詳細設定でウォーターマークON/OFF（既定ON、`DEFAULT_RECORDING_OPTIONS`）と
   **低速録画**（Issue #68）。th20のリプレイならタイトル固有の注意書きも出す。
3. メール入力＋解析・アップロードとも成功で「次のステップ」ボタンが活性化
   （`requestMagicLink()`に渡す`replayKey`はアップロード完了後にしか手に入らないため、
   ボタンはアップロード完了も待つ）。押下で`requestMagicLink()`（`POST /magic-links`）を
   呼び、`MagicLinkSent`画面へ遷移する。

> **低速録画オプション（Issue #68）の出し分け条件と、th20の注意書き（Issue #87）は
> [`docs/upload-form.md`](docs/upload-form.md) にある**。特に
> **「ワーカーがthpracを適用した後もこの注意書きを残す理由」（Issue #105）は消さないこと**
> —— 条件を取り違えると、選ばせたのに等倍で録画される／2倍速の壊れた動画ができる。

## 3. ページBのフロー（`pages/JobPage.tsx`）

1. マウント時に`StartJob`が自動的に`startJob()`（`POST /jobs/{jobId}/start`）を呼ぶ。
   既に起動済みのジョブへの再アクセスも冪等に成功として扱われる。
2. 起動後は`JobProgress`が`useJobPolling`フック経由でポーリング表示を行う。

### 3.1 ポーリング（`hooks/useJobPolling.ts`）

低速録画（Issue #68）のジョブは録画フェーズに実時間で2倍かかる。進捗バジェット
（`hooks/jobProgressBudget.ts`）はこれを`GetJobResponse.slowMotion`から織り込む。
**織り込まないと録画の途中でバジェットを使い切り、「残り約○分」が消えたうえ
`isPhaseOverrun()`がリトライ疑いを誤検知する**（悲観バジェットの1.5倍を、2倍かかる
録画は必ず超えるため）。ワーカーが報告する`progress`は実時間ではなく**コンテンツ秒数**
なので、バジェット（実時間）と突き合わせる箇所では`recordingContent`を換算係数に使う。
変換フェーズは等倍に戻した後の動画が対象なのでスケールしない。

`getJob()`を3秒間隔（`POLL_INTERVAL_MS`）で呼び続け、`isTerminalStatus()`
（`done`/`failed`）に達したら停止する。取得エラー時も（連続失敗を想定して）
ポーリングは止めず再試行する。

> WebSocket/SSE ではなく単純ポーリングにした理由と採らなかった選択肢は
> [`docs/decisions/0006`](../../docs/decisions/0006-progress-polling-not-websocket.md)。

### 3.2 経過時間表示は巻き戻らない（`hooks/useEstimatedProgress.ts`、Issue #108）

録画・変換フェーズの「○:○○ 経過」は、ポーリング（3秒間隔）でしか届かないサーバー値を
実時間で補間して滑らかに見せている。サーバー値からの**外挿**（先読みして追い越し、次の
ポーリングで同期＝巻き戻る）ではなく、**サーバー値を上限とする内挿**にしてある。
フェーズに入った時点で表示値をサーバー値より`WORKER_PROGRESS_INTERVAL_SECONDS`
（=10秒。ワーカーが進捗を書き込む間隔）だけ手前に置き、そこからフェーズの速度で進める。
遅れが開いた場合（タブが裏に回ってティックが間引かれた等）は同じ秒数で埋め切る速度まで
一時的に上げて追いつく。`launching`のように進捗が意味を持たないフェーズでは、レコードに
値が残っていても表示しない。

> **この保証はワーカー側の書き込み方（フェーズ開始時に`status`と`progress`を同時に
> 書く）に依存している**。満たすべき2つの性質と、崩したときに何が起きるかは
> [`docs/decisions/0023`](../../docs/decisions/0023-elapsed-time-interpolation-never-rewinds.md)。

## 4. ダウンロード（`components/JobProgress.tsx`）

`GetJobResponse.downloadUrl`/`.downloadUrl720p`（CloudFront配信、
`response-content-disposition`クエリ付き）へ単純な`<a href={...} download>`を張るだけ。
ブラウザ標準のダウンロード機構（進捗表示・タブを離れても継続）を使うため、
fetch+Blob化やCORS許可は不要（`apps/api/README.md`参照）。

**出力が1本のジョブでは`downloadUrl720p`が null になる**（th20・低速録画。解像度が
変わらない/生データが半分の速度で使えないため、変換結果1本に集約する。
`worker/convert.py`の`needs_separate_raw_output()`）。主要ボタンは
`downloadUrl720p ?? downloadUrl`のフォールバックでそのまま本命を指し、副次リンク
（「変換前の動画をダウンロード」）は両方揃っているときだけ出す。

## 5. 完了後のプレビュー再生（`components/JobProgress.tsx`、Issue #71）

`status: "done"`のとき、`GetJobResponse.previewVideoUrl`（配信版のCDN URL。
ダウンロード用と違い`response-content-disposition`は付かない）を`<video controls>`で
そのまま再生できるようにしている。

**この画面で最も気を遣うべきはCloudFrontの配信量**である。動画1本は720p版で平均
約1GiBあり、月1000録画で常時無料枠(1TB/月)をほぼ使い切る水準にある
（`docs/research/aws-region-cost-analysis.md` §6）。プレビューが「もう1回ダウンロードされる」
のと同義になると配信量が単純に倍増するため、次の前提を崩さないこと。

- **`preload="none"` は必須**。既定値（`metadata`）だと、ジョブページを開いただけで
  全員ぶんのmoov atom取得リクエストが走る。`preload="none"`なら再生ボタンを押すまで
  1バイトも取得されない（Chromeの実測で確認済み。ページロード後に動画URLへの
  リクエストが一切発生しないこと・同じページのposter画像は取得されていることを
  DevToolsのネットワーク記録で確認）。
- 再生前に真っ黒な矩形を出さないための`poster`には、録画中スクリーンショット
  （数十KB）を流用する。このために`GET /jobs/{jobId}`は`done`でも
  `previewImageUrl`を返す。
- 再生後はブラウザがRangeリクエストで先読みし、バッファが十分たまった時点で受信を
  止める（S3・CloudFrontともRange対応）。途中まで見て閉じれば転送量もその分で済む。
  ただし**全編を視聴した上でダウンロードもされれば配信量は2倍**になる。これは
  避けようがないので、`autoPlay`を付けない・音量を勝手に上げない等、
  「ユーザーが意図して再生したときだけ流れる」状態を保つことで抑える。

## 6. 多言語対応（i18n、`src/i18n/`）

`i18next` + `react-i18next`。日本語（既定、プレフィックス無し）と英語（`/en`
プレフィックス）の2言語のみ対応。

- `i18n/i18n.ts`: i18next初期化。翻訳リソースは`i18n/locales/{ja,en}/translation.json`
  （コンポーネント名でネストしたキー構成）。**言語はブラウザ検出ではなく常にURLパスのみで
  決まる**（`fallbackLng`はja）。マジックリンクメールのURLはバックエンドが
  `/jobs/{jobId}`固定で生成する（`apps/api/src/ses.ts`）ため、既定言語(ja)は常に
  プレフィックス無しで到達できる必要があり、これがブラウザ言語自動リダイレクトを
  行わない理由。
- `App.tsx`の`<Routes>`はja用（`/`配下）・en用（`/en`配下）の2つの同型ツリーを持ち、
  各ツリーの`Layout`が`lang` propを受けて`i18n.changeLanguage()`する。配下のページ・
  コンポーネントは`i18n/LocaleContext.ts`の`useLocale()`で現在言語を参照できる
  （言語をまたぐ`navigate()`・`Link`の行き先組み立てに使う）。
- `i18n/paths.ts`の`toLocalizedPath(pathname, lang)`で、現在のパスを保ったまま
  他言語の等価パスへ変換する（例: `/jobs/xxx` ⇔ `/en/jobs/xxx`）。ヘッダーの
  `LanguageSwitcher`（`components/LanguageSwitcher.tsx`、ページ右上に常時表示）や
  `JobPage`の「最初からやり直す」導線で使用。
- `GAME_TITLES`（`@sattori/shared`、公式タイトル名+英語副題）自体は言語を問わず共通表示。
  `UploadForm`の対応タイトル一覧のみ、各タイトルが持つ`japanese`/`english`表記を
  `i18n.language`で出し分けている。
- API（Lambda）・ワーカーが返すエラーメッセージ本体（`SattoriApiError.message`・
  `GetJobResponse.error`）は常に日本語固定（バックエンド側は日英出し分けを持たない）。
  代わりに機械可読な`code`（`SattoriApiError.code`・`ReplayParseFailure.code`・
  `GetJobResponse.errorCode`）を軸に、`i18n/apiErrors.ts`の`translateApiErrorMessage()`が
  `errors.<code>`キー（両ロケール）へ翻訳し、キーが無い（追加漏れ・想定外のコード）場合は
  バックエンドの日本語メッセージへフォールバックする（Issue #138）。`errorCode`が無い
  旧ジョブの`GetJobResponse.error`もこの経路が無いため日本語のまま表示される
  （`JobProgress.tsx`）。

### 6.1 エントリHTML・OGPの言語出し分け

クローラー（X/Discord/Slack等のunfurl bot）はJSを実行しないため、`<title>`・
`description`・OGP・`<html lang>`はReact側からでは出し分けられない。そこで
**エントリHTMLを言語ごとに実体として持つ**:

- `index.html`（ja）と`en/index.html`（en）の2ファイル。Viteのマルチページ入力
  （`vite.config.ts`の`build.rollupOptions.input`）で`dist/index.html`・
  `dist/en/index.html`として出力する。JS/CSSのチャンクは共通のものを参照するので
  バンドルは二重化しない。
- 2ファイルは「言語依存のメタ情報だけが異なる同型のHTML」であること。
  `src/test/htmlMeta.test.ts`が`<meta>`キー集合の一致・`lang`/`og:locale`/`og:url`の
  言語別の正しさ・hreflangの相互参照を検証しているので、片方だけにタグを足すと落ちる。
- **OGPにジョブ固有の情報を含めないこと**。`/jobs/{jobId}`にも同じHTMLが配られ、
  `jobId`は認可の秘密値であるため、URLを貼った先のunfurl botがこのHTMLを取得しに来る。
- `og:image`は絶対URL必須。実体は`public/og-image-{ja,en}.jpg`（1200x630）で、
  キャッチコピー（`app.tagline`相当）を画像に焼いているため**言語ごとに別ファイル**。
  ファイル名を変えたら両HTMLの`og:image`も直すこと（上記テストが`public/`配下の
  実体の存在も検証しているので、リネームだけすると落ちる）。
- どのURLでどちらのHTMLが配られるかは本番ではCloudFront Functionが決める
  （`infra/README.md`参照）。開発サーバでも同じ振り分けになるよう、`vite.config.ts`の
  `sattori:en-locale-spa-fallback`プラグインが`/en`配下を`en/index.html`へ書き換える。

### 6.2 sitemap.xml・robots.txt・SPAページのメタ情報動的更新（Issue #214）

- `public/sitemap.xml`・`public/robots.txt`はそのまま静的配信される。sitemapは公開静的
  ページ（`/`, `/about`, `/info`, `/terms`, `/changelog`, `/replay-help`）についてja/en
  それぞれのURLを列挙し、`xhtml:link`でhreflang（`ja`/`en`/`x-default`）を相互参照する。
  ページを追加・削除したら両ファイルと`src/test/sitemap.test.ts`（App.tsxのルート一覧との
  整合を検証）を同時に直すこと。**`public/`配下はViteMinifyPlugin（§6.1、コメント除去は
  `index.html`/`en/index.html`にしか効かない）の対象外でそのままコピーされるため、
  この2ファイルにはXMLコメント等の内部事情を書かないこと**（Issue番号のような実装詳細を
  書いても、`ViteMinifyPlugin`によるコメント除去は効かず一般公開されてしまう）。
- `robots.txt`は`/admin/`・`/api/`・`/jobs/`・`/en/jobs/`のクロールを止める。`jobId`は
  認可の秘密値（[`docs/decisions/0004`](../../docs/decisions/0004-job-id-as-authorization-secret.md)）
  であり、そもそも外部にリンクされないURLなのでクロール自体を抑止する。
- `<title>`・`<link rel="canonical">`はエントリHTMLがトップページの値を静的に持つのみで、
  他のSPAページ（`/about`等）ではJS実行後にクライアント側で書き換える（静的HTML1枚で
  全ルートを配るため）。`hooks/usePageMeta.ts`の`usePageMeta({ title, path, noindex })`が
  各ページコンポーネントのマウント時に`document.title`・`link[rel="canonical"]`の`href`を
  上書きし、`noindex: true`のときだけ`<meta name="robots" content="noindex">`を追加する
  （既存のタグを使い回すので、ページ遷移のたびに増殖しない）。`title`省略時はトップページの
  既定タイトルに戻る。`JobPage`はジョブ固有の情報を含まない汎用タイトルで`noindex: true`を
  渡す（上記のとおりrobots.txt側でも二重に止めている）。

## 7. APIクライアント（`src/api/client.ts`）

`VITE_API_BASE`（既定 `/api`）を基点に`fetch`でAPIを呼ぶ薄いラッパー。エラーレスポンス
（`ApiError`）は`SattoriApiError`（`code`/`message`/`status`）に変換して投げる。`status`
（HTTPステータスコード）は管理画面がAPI Gatewayのauthorizer拒否（401/403）を判別する
ために追加した。authorizer拒否時のレスポンスは`{"message":"Unauthorized"}`のような
API Gateway自身の形式で、このAPIの`ApiError`（code/message）形ではないため`code`では
判別できない。`request<T>()`自体も`export`しており、管理画面用ラッパー
（`src/admin/adminApi.ts`）が`Authorization`ヘッダー付きで呼び出すのに再利用する
（fetchとエラー整形の実装を二重化しないため）。

## 8. 管理画面（`src/admin/`、Issue #51）

運用調査用のジョブ一覧・詳細・ダウンロード導線、ジョブの緊急停止・再実行（Issue #59）、
コスト集計（Issue #60）、キルスイッチ・月間コストガードの設定（Issue #14）。ユーザーは
管理者1人固定で、SSMの共有トークンを`localStorage`に保持して`Authorization: Bearer`で
送る（本体の認可はAPI Gateway側のLambda Authorizer。
[`docs/decisions/0005`](../../docs/decisions/0005-admin-auth-ssm-shared-token.md)）。

**利用者向けの本流フローとは完全に独立しているため、詳細は
[`docs/admin-ui.md`](docs/admin-ui.md) に分けてある**（画面構成・操作パネルの活性条件・
ワーカー種別による文言の出し分け・コスト表示の約束など）。API側は
[`apps/api/docs/admin-api.md`](../api/docs/admin-api.md)。

## 9. 計測（アナリティクス、Issue #142）

Cookie/localStorageを一切使わないサーバーサイド計測。`src/api/analytics.ts`が
`POST /beacon`へビーコンを送る（`navigator.sendBeacon`、非対応環境は`fetch`
`keepalive`にフォールバック）。

- `hooks/useAnalyticsPageview.ts`を`App.tsx`の`Layout`から呼び、ルート変更
  （`react-router-dom`の`useLocation()`）ごとにpageviewイベントを送る。`/admin/*`は
  `Layout`を経由しない別ツリー（`AdminApp`）なので自然に計測対象から外れる。
- パス中のUUIDセグメント（`jobId`のような秘密値、[`docs/decisions/0004`](../../docs/decisions/0004-job-id-as-authorization-secret.md)）は
  送信前に`:id`へ正規化する（`analytics.ts`の`normalizePath()`）。
- `components/UploadForm.tsx`の`parseLocally()`が`parseReplayInfo()`失敗時に
  `trackParseError()`を呼ぶ（`unsupported_game`なら検出タイトルも送る）。
- **`/beacon`は`API_BASE`（`api/client.ts`）を経由しない固定の相対パス**。本番では
  現在ページと同一オリジン（WebCdnのカスタムドメイン）に解決させることで、
  CloudFrontの`/beacon`ビヘイビア経由になり`CloudFront-Viewer-Country`ヘッダーが
  付与される（`infra/README.md`）。開発サーバでは`vite.config.ts`が`/api`と同じく
  `:8787`へプロキシするだけで、CloudFrontを経由しないため国情報は付かない。

> 収集する情報の一覧・「あえて集めないもの」の判断根拠は
> [`docs/decisions/0024`](../../docs/decisions/0024-cookieless-analytics-beacon.md)。

## 10. 開発サーバ

```bash
pnpm --filter @sattori/web dev
```

`vite.config.ts`: ポート5173、`/api`を`http://localhost:8787`へプロキシ
（`VITE_API_BASE`が設定されていればプロキシは無効化され、そちらを直接叩く）。

## 11. テスト

コンポーネント単位で`*.test.tsx`（vitest + jsdom、`src/test/setup.ts`）。
`pnpm --filter @sattori/web test`。
