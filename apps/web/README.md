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

## API クライアント（`src/api/client.ts`）

`VITE_API_BASE`（既定 `/api`）を基点に`fetch`でAPIを呼ぶ薄いラッパー。エラーレスポンス
（`ApiError`）は`SattoriApiError`（`code`/`message`）に変換して投げる。

## 開発サーバ

```bash
pnpm --filter @sattori/web dev
```

`vite.config.ts`: ポート5173、`/api`を`http://localhost:8787`へプロキシ
（`VITE_API_BASE`が設定されていればプロキシは無効化され、そちらを直接叩く）。

## テスト

コンポーネント単位で`*.test.tsx`（vitest + jsdom、`src/test/setup.ts`）。
`pnpm --filter @sattori/web test`。
