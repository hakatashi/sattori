# apps/web

フロントエンド SPA（Vite + React + CSS Modules、`react-router-dom`でクライアント
サイドルーティング）。API契約は `packages/shared/README.md` を参照。

## ルーティング（`src/App.tsx`）

- `/` = ページA（`HomePage`）: リプレイのアップロード〜マジックリンク送信要求。
- `/jobs/:jobId` = ページB（`JobPage`）: マジックリンクのリンク先。アクセスで自動的に
  録画を起動し、進捗ポーリング・DLボタン表示まで担う。`jobId`のみで認可する
  （メールを確認しないと分からない秘密値。URLに他の認可情報は含まない）。
- 上記2ルートは`/en`配下（`/en`・`/en/jobs/:jobId`）にも同型で存在する（英語版、
  詳細は下記「多言語対応」）。未定義パスはそれぞれ`/`・`/en`へリダイレクト。
- `/admin/*` = 管理画面（`src/admin/`、Issue #51）。ja/enどちらのツリーにも属さない
  独立ルートで、日本語固定・i18n非適用。`React.lazy`で別チャンクに分離しているため、
  一般ユーザーのバンドルには含まれない。ja/enツリーの`catch-all(<Route path="*">)`より
  **前**に定義する必要がある（後ろだと`/admin`が`/`へ即リダイレクトされてしまう）。
  詳細は下記「管理画面」。
- 共通レイアウト（ヘッダー・フッター）は`Layout`。ページBはページAより広い画面幅
  （2カラムのリプレイ情報+アクティビティログ）を活かすため、`useMatch`でページBのみ
  最大幅を広げている。
- 開発時は `?preview=replay` / `?preview=job` クエリで、実データ無しに
  `ReplayPreview`/`JobProgress`の見た目を確認できる（`dev/*Playground.tsx`、
  `import.meta.env.DEV`ガードで本番ビルドには含まれない）。

## ページAのフロー（`components/UploadForm.tsx`）

1. ファイル選択で即座に自動実行: `createUpload()`で署名付きURL取得 →
   `uploadReplay()`でS3へ直接PUT → `parseReplay()`で解析。
2. 解析成功で`ReplayPreview`にゲーム名/キャラ/スコア/クリア可否等を表示。
   詳細設定でウォーターマークON/OFF（既定ON、`DEFAULT_RECORDING_OPTIONS`）。
3. メール入力＋解析成功で「次のステップ」ボタンが活性化。押下で
   `requestMagicLink()`（`POST /magic-links`）を呼び、`MagicLinkSent`画面へ遷移する。

## ページBのフロー（`pages/JobPage.tsx`）

1. マウント時に`StartJob`が自動的に`startJob()`（`POST /jobs/{jobId}/start`）を呼ぶ。
   既に起動済みのジョブへの再アクセスも冪等に成功として扱われる。
2. 起動後は`JobProgress`が`useJobPolling`フック経由でポーリング表示を行う。

### ポーリング（`hooks/useJobPolling.ts`）

`getJob()`を3秒間隔（`POLL_INTERVAL_MS`）で呼び続け、`isTerminalStatus()`
（`done`/`failed`）に達したら停止する。月間最大1000回規模ではWebSocket/SSEは過剰、
という判断でシンプルな単純ポーリングを採用している（`AGENTS.md`参照）。取得エラー時も
（連続失敗を想定して）ポーリングは止めず再試行する。

## ダウンロード（`components/JobProgress.tsx`）

`GetJobResponse.downloadUrl`/`.downloadUrl720p`（CloudFront配信、
`response-content-disposition`クエリ付き）へ単純な`<a href={...} download>`を張るだけ。
ブラウザ標準のダウンロード機構（進捗表示・タブを離れても継続）を使うため、
fetch+Blob化やCORS許可は不要（`apps/api/README.md`参照）。

## 多言語対応（i18n、`src/i18n/`）

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
- API（Lambda）が返すエラーメッセージ（`SattoriApiError.message`）は日本語固定
  （バックエンド側は未対応）。フロント側の文言のみが対象。

### エントリHTML・OGPの言語出し分け

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

## API クライアント（`src/api/client.ts`）

`VITE_API_BASE`（既定 `/api`）を基点に`fetch`でAPIを呼ぶ薄いラッパー。エラーレスポンス
（`ApiError`）は`SattoriApiError`（`code`/`message`/`status`）に変換して投げる。`status`
（HTTPステータスコード）は管理画面がAPI Gatewayのauthorizer拒否（401/403）を判別する
ために追加した。authorizer拒否時のレスポンスは`{"message":"Unauthorized"}`のような
API Gateway自身の形式で、このAPIの`ApiError`（code/message）形ではないため`code`では
判別できない。`request<T>()`自体も`export`しており、管理画面用ラッパー
（`src/admin/adminApi.ts`）が`Authorization`ヘッダー付きで呼び出すのに再利用する
（fetchとエラー整形の実装を二重化しないため）。

## 管理画面（`src/admin/`、Issue #51）

運用調査用のジョブ一覧・詳細・ダウンロード導線と、ジョブの緊急停止・再実行
（Issue #59）。ユーザーは管理者1人固定。API側の詳細は
`apps/api/README.md`「管理API」を参照。

- **認証**: SSM Parameter Store（`/sattori/admin/token`）に置いた共有トークンを
  `localStorage`（`adminToken.ts`、キー`sattori.adminToken`）に保持し、
  `Authorization: Bearer <token>`で送る。API Gateway側のLambda Authorizerが本体の
  認可で、フロント側のログインゲート（`AdminApp.tsx`）はUX目的（未ログイン時は
  API呼び出し自体を発生させない）。401/403（`AdminUnauthorizedError`、`adminApi.ts`）を
  受けた画面は`AdminAuthContext.onUnauthorized`経由で`AdminApp`に伝わり、トークンを
  クリアして再ログインを促す。`localStorage`への読み書きは3関数とも`try`/`catch`で
  包んである（プライベートブラウジング等で`setItem`が例外を投げると、`/admin`配下に
  エラーバウンダリが無いためログイン操作だけで画面が白くなる。セッション限りの
  ログインへ縮退させる）。
- **構成**: `AdminApp.tsx`（認証ゲート＋内部`<Routes>`）→ `JobListPage.tsx`（一覧・
  status絞り込み・カーソルページング。状態は`useSearchParams`でURLに載せる）／
  `JobDetailPage.tsx`（`JobRecord`全フィールド＋ダウンロード導線＋コスト推定）／
  `CostsPage.tsx`（コスト集計、Issue #60）／
  `ExecutionPanel.tsx`（Step Functions実行状態、`JobDetailPage`とは別にfetchする。
  理由は`apps/api/README.md`参照）。データ取得は共通フック`useAdminResource.ts`
  （`AdminUnauthorizedError`を検知して`onUnauthorized`を呼ぶ）に集約。
- **操作パネル**（`JobActionsPanel.tsx`、Issue #59）: ジョブ詳細画面から緊急停止
  （`done`以外のときに活性）と再実行（終端状態かつ未再実行のときのみ活性）を行う。
  緊急停止を`failed`でも押せるようにしているのは、ワーカーが`SendTaskFailure`より先に
  `failed`を書くため「statusは`failed`なのにステートマシンはリトライ中＝EC2が起動し
  続けている」状態がありうるため（`apps/api/README.md`参照。停止可否の最終判断は
  API側がStep Functionsの実行状態を見て行い、止めるものが無ければ409）。逆に再実行は
  `retriedToJobId`が既にあると押せない（同一リプレイの二重録画を避けるため。API側も
  原子的に排他する）。どちらも
  取り返しのつかない操作（EC2の強制終了・新規インスタンス起動による課金）なので
  `window.confirm`での確認を必須にしている。再実行は**新しいjobIdのジョブ**が作られる
  ため、結果メッセージからその詳細画面へのリンクを出す（元ジョブ側の
  `retriedToJobId`／新ジョブ側の`retriedFromJobId`フィールドからも相互に辿れる）。
  操作後は`useAdminResource`の`reload()`でジョブ詳細を取り直す。`reload()`は
  deps変更時と違い取得中も直前の`data`を保持する（パネルが一瞬アンマウントされて
  実行結果メッセージが消えるのを避けるため）。
- **コスト表示**（Issue #60）: ジョブ詳細の`JobCostPanel.tsx`（1ジョブぶんの内訳）と
  `CostsPage.tsx`（`/admin/costs`、日次/週次/月次の集計と推移）。計算は
  `@sattori/shared`の`estimateJobCost()`をそのまま呼ぶ（集計APIと同じ実装を共有し、
  画面ごとに数字が食い違わないようにする）。**ジョブ詳細のコストはサーバーに計算させて
  いない**——`AdminJobDetailResponse`は`JobRecord`をそのまま返すので、フロントで
  推定関数を呼べば足り、APIの契約を増やさずに済むため。
  積み上げ棒はCSSのflexで描き、チャートライブラリは入れていない（この規模の図に
  依存を1本増やす価値がない）。系列色は色覚特性・ライト/ダーク双方のコントラストを
  検証済みのカテゴリカルパレットを固定順で割り当てており（`CostsPage.module.css`
  冒頭のコメント参照）、**順番の入れ替えや循環をしないこと**。棒の色だけに情報を
  持たせないよう、凡例に系列名と期間合計の数値を併記し、各行に合計金額を出す。
  表示が推定値であること・仮定が混ざっている件数（`quality`）は必ず画面に出す。
- **レイアウト**: `AdminLayout.tsx`はユーザー向け`App.tsx`の`Layout`とは共有しない
  専用シェル（`LanguageSwitcher`が存在しない`/en/admin`へのリンクを出してしまうことと、
  ユーザー向け`main`幅(50rem)がジョブ一覧テーブルには狭すぎることが理由）。CSS Modules
  + `global.css`の既存トークン（`--panel`等）を再利用し、`:root`自体は変更しない。

## 開発サーバ

```bash
pnpm --filter @sattori/web dev
```

`vite.config.ts`: ポート5173、`/api`を`http://localhost:8787`へプロキシ
（`VITE_API_BASE`が設定されていればプロキシは無効化され、そちらを直接叩く）。

## テスト

コンポーネント単位で`*.test.tsx`（vitest + jsdom、`src/test/setup.ts`）。
`pnpm --filter @sattori/web test`。
