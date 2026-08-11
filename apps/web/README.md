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
   **低速録画**（Issue #68、後述）。th20のリプレイならタイトル固有の注意書きも出す。
3. メール入力＋解析・アップロードとも成功で「次のステップ」ボタンが活性化
   （`requestMagicLink()`に渡す`replayKey`はアップロード完了後にしか手に入らないため、
   ボタンはアップロード完了も待つ）。押下で`requestMagicLink()`（`POST /magic-links`）を
   呼び、`MagicLinkSent`画面へ遷移する。

### 低速録画オプション（Issue #68）

ゲームを 1/2 倍速で走らせて録画し後処理で等倍へ戻す方式で、等倍では処理落ちする
th20（Issue #87）の品質を担保する。UI上の要件は「**低速録画に対応したタイトル**で、
かつ自宅ワーカーが使えるとき、かつその場合に限り選べる」「選べるなら th20 だけ
既定オン」「選べないならグレーアウト」。

- 対応タイトルは`supportsSlowMotion(game)`（`@sattori/shared`、現状 th20 のみ。
  他タイトルへの展開は Issue #101）で判定する。速度を落とす仕組みがタイトルのMOD側に
  あるため、**非対応タイトルで要求するとゲームは等倍で動くのに後処理だけが等倍化を
  行い、2倍速の動画が出来上がる**（しかも生データは削除される）。`POST /magic-links`
  も同じ判定で握り潰すが、UIはその前に選ばせない。
- マウント時に`getWorkerAvailability()`（`GET /worker-availability`）を**1回だけ**引く。
  実際に録画が始まるのはユーザーがマジックリンクを開いた後（最大24時間後）で、その
  時点の可否とはどのみち一致しないため、ポーリングして精度を上げても意味がない。
  取得に失敗した場合も「使えない」（グレーアウト）に倒す——選択肢を出しておいて実際は
  等倍で録画される、という食い違いを避けるため。
- 既定値は`defaultSlowMotionFor(game, available)`（`@sattori/shared`）が決める。
  ユーザーが一度でもチェックを触ったらその意思を尊重し、以後タイトルが変わっても
  追従させない。
- 送信する値は「チェック状態」ではなく
  `slowMotionAvailable && supportsSlowMotion(game) && slowMotion`という導出値を使う。
  可否やタイトルが変わったときにstateが取り残されないようにするため。
- 選べない理由（タイトル未対応／ワーカーが混雑）はヒント文で区別して出す。前者は
  待っても変わらないが、後者は時間をおけば変わるため。

### th20の注意書き（Issue #87）

th20のリプレイを解析したときだけ、STEP2のプレビュー直下に2点を出す。**メールアドレスを
入力して録画を依頼してしまう前に**知らせるのが目的:

- **デシンク（リプレイずれ）が頻発する**: リプレイファイル・ゲーム本体側の現象で、
  録画側では検知も対処もできない（touhou-recorder reports/45）。再録画しても同じ結果。
- **等倍録画では品質が落ちる**: 低速録画が有効なときは該当しないので出さない。

## ページBのフロー（`pages/JobPage.tsx`）

1. マウント時に`StartJob`が自動的に`startJob()`（`POST /jobs/{jobId}/start`）を呼ぶ。
   既に起動済みのジョブへの再アクセスも冪等に成功として扱われる。
2. 起動後は`JobProgress`が`useJobPolling`フック経由でポーリング表示を行う。

### ポーリング（`hooks/useJobPolling.ts`）

低速録画（Issue #68）のジョブは録画フェーズに実時間で2倍かかる。進捗バジェット
（`hooks/jobProgressBudget.ts`）はこれを`GetJobResponse.slowMotion`から織り込む。
**織り込まないと録画の途中でバジェットを使い切り、「残り約○分」が消えたうえ
`isPhaseOverrun()`がリトライ疑いを誤検知する**（悲観バジェットの1.5倍を、2倍かかる
録画は必ず超えるため）。ワーカーが報告する`progress`は実時間ではなく**コンテンツ秒数**
なので、バジェット（実時間）と突き合わせる箇所では`recordingContent`を換算係数に使う。
変換フェーズは等倍に戻した後の動画が対象なのでスケールしない。

`getJob()`を3秒間隔（`POLL_INTERVAL_MS`）で呼び続け、`isTerminalStatus()`
（`done`/`failed`）に達したら停止する。月間最大1000回規模ではWebSocket/SSEは過剰、
という判断でシンプルな単純ポーリングを採用している（`AGENTS.md`参照）。取得エラー時も
（連続失敗を想定して）ポーリングは止めず再試行する。

## ダウンロード（`components/JobProgress.tsx`）

`GetJobResponse.downloadUrl`/`.downloadUrl720p`（CloudFront配信、
`response-content-disposition`クエリ付き）へ単純な`<a href={...} download>`を張るだけ。
ブラウザ標準のダウンロード機構（進捗表示・タブを離れても継続）を使うため、
fetch+Blob化やCORS許可は不要（`apps/api/README.md`参照）。

**出力が1本のジョブでは`downloadUrl720p`が null になる**（th20・低速録画。解像度が
変わらない/生データが半分の速度で使えないため、変換結果1本に集約する。
`worker/convert.py`の`needs_separate_raw_output()`）。主要ボタンは
`downloadUrl720p ?? downloadUrl`のフォールバックでそのまま本命を指し、副次リンク
（「変換前の動画をダウンロード」）は両方揃っているときだけ出す。

## 完了後のプレビュー再生（`components/JobProgress.tsx`、Issue #71）

`status: "done"`のとき、`GetJobResponse.previewVideoUrl`（配信版のCDN URL。
ダウンロード用と違い`response-content-disposition`は付かない）を`<video controls>`で
そのまま再生できるようにしている。

**この画面で最も気を遣うべきはCloudFrontの配信量**である。動画1本は720p版で平均
約1GiBあり、月1000録画で常時無料枠(1TB/月)をほぼ使い切る水準にある
（`docs/aws-region-cost-analysis.md` §6）。プレビューが「もう1回ダウンロードされる」
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
  `JobDetailPage.tsx`（`JobRecord`全フィールド＋ダウンロード導線＋コスト推定＋
  ユーザー向けジョブページへのリンク）／`LogsPanel.tsx`（ワーカーログ、Issue #58）／
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
- **ユーザー向けジョブページへのリンク**（`JobDetailPage.tsx`）: ジョブ詳細から
  ページB（`/jobs/{jobId}`、英語のジョブなら`/en/jobs/{jobId}`）を別タブで開ける。
  jobId自体が認可の秘密値（`AGENTS.md` §3）なので、管理者もこのURLを開けば
  ユーザーとまったく同じ画面を確認できる。同一SPA内だが`<Link>`にすると管理画面から
  離脱してしまうため`target="_blank"`にしている。
- **ワーカーログ**（`LogsPanel.tsx`、Issue #58）: CloudWatch Logs
  （ロググループ`/sattori/worker`、ストリーム名=jobId）を新しい方から読む。
  自宅ワーカーのログも同じストリームへ転送されるため（`home-worker/src/logShipper.ts`）、
  表示側はワーカーの種別を意識しない。
  - 初回読み込み後は末尾（最新行）まで自動スクロールする。さらに**ジョブが実行中で
    かつ表示が末尾にある間だけ**10秒ごとに最新ページを取り直して追尾する（`tail -f`相当）。
    末尾判定は`followingTail`のようなstateではなく**毎回DOMの実際のスクロール位置**で
    行う（履歴を遡って読んでいる最中に末尾へ飛ばされるのを防ぐため。stateは注記の
    表示にしか使わない）。
  - 自動更新は「さらに古いログを読み込む」で積んだ履歴を捨てないよう、取り直した
    最新ページを`mergeTailEvents()`で継ぎ足す。`GetLogEvents`のイベントには識別子が
    無いため`(timestamp, message)`の一致で重なりを探す近似で、重なりが見つからない
    （＝前回の更新から1ページぶん以上流れた）ときだけ履歴を捨てて`nextBackwardToken`も
    取り直す。
- **ワーカー種別（EC2 / 自宅サーバー）による文言の出し分け**（Issue #49）: ジョブ詳細の
  ワーカー欄・操作パネル・コスト推定・ログの「ストリームが見つからない」説明は
  `workerKind`で切り替える。自宅ワーカーのジョブに「EC2インスタンスを強制終了し」
  「Spot単価」と出すのは端的に誤りで、停止の効き方（terminateで即座に止まるEC2 /
  claim解除にデーモンが気づくまで最大30秒走り続ける自宅ワーカー）も課金の有無も違う。
  コスト推定のSpot単価は**自宅ワーカーのジョブでは表示しない**（計算に使われていない
  フォールバック定数が「この単価で課金された」と読まれてしまうため）。ただし再実行の
  確認文言だけは自宅ワーカーのジョブでもEC2課金に触れる——再実行は`workerKind: null`の
  新しいジョブを作るので、割り当ては改めて決まる（`apps/api/src/handlers/admin/retryJob.ts`）。
- **コスト表示**（Issue #60）: ジョブ詳細の`JobCostPanel.tsx`（1ジョブぶんの内訳）と
  `CostsPage.tsx`（`/admin/costs`、日次/週次/月次の集計と推移）。計算は
  `@sattori/shared`の`estimateJobCost()`をそのまま呼ぶ（集計APIと同じ実装を共有し、
  画面ごとに数字が食い違わないようにする）。**ジョブ詳細のコストはサーバーに計算させて
  いない**——`AdminJobDetailResponse`は`JobRecord`をほぼそのまま返す（`AdminJobRecord`。
  秘密値を含む`homeWorkerEnv`だけ伏せてある）ので、フロントで推定関数を呼べば足り、
  APIの契約を増やさずに済むため。
  積み上げ棒はCSSのflexで描き、チャートライブラリは入れていない（この規模の図に
  依存を1本増やす価値がない）。系列色は色覚特性・ライト/ダーク双方のコントラストを
  検証済みのカテゴリカルパレットを固定順で割り当てており（`CostsPage.module.css`
  冒頭のコメント参照）、**順番の入れ替えや循環をしないこと**。棒の色だけに情報を
  持たせないよう、凡例に系列名と期間合計の数値を併記し、各行に合計金額を出す。
  表示が推定値であること・仮定が混ざっている件数（`quality`）は必ず画面に出す。
- **通貨切り替え**（`adminCurrency.ts` / `costFormat.ts`）: コスト表示をUSDと円で
  切り替えられる。選択は`AdminLayout`のヘッダーに置き（コスト表示のある画面が複数ある
  ため）、`CostCurrencyContext`で配下に配り、`localStorage`に保存する（読み書きは
  トークンと同じく`try`/`catch`で握り潰し、既定のUSDへ縮退する）。換算は
  `@sattori/shared`の`usdToJpy()`＝固定レートによる概算で、円表示のときだけ
  「固定レートによる概算」である旨の注記を出す。円は小数を**USD表示より2桁少なく**
  する（$1≒¥157なので、$0.0360→¥5.65、$0.17→¥27で情報量が釣り合う）。
- **設定画面**（`SettingsPage.tsx`、`/admin/settings`、Issue #14）: キルスイッチ
  （`acceptingNewJobs`）と月間コストガードの上限額（`monthlyCostLimitUsd`）を
  管理する。キルスイッチは新規録画の受付を即座に停止・再開するトグルで、
  当月の推定コスト（`estimateJobCost()`の月次集計。`CostsPage.tsx`と同じ推定値で
  請求額そのものではない）を上限額に対するゲージで表示する。どちらもユーザー向けの
  サービス提供可否に直結する変更のため、`JobActionsPanel`と同じ方針で
  `window.confirm`による確認を保存前に必須にしている。API側の反映タイミングの
  非対称性（キルスイッチは次のリクエストから即反映、月間コストガードの閾値は
  ユーザー向け経路のキャッシュにより最大5分遅れる）は`apps/api/README.md`
  「キルスイッチ・月間コストガード」参照。
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
