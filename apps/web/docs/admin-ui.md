# 管理画面（`src/admin/`、Issue #51）

運用調査用のジョブ一覧・詳細・ダウンロード導線と、ジョブの緊急停止・再実行
（Issue #59）、コスト集計（Issue #60）、訪問者アナリティクス集計（Issue #149）、
キルスイッチ・月間コストガードの設定（Issue #14）。ユーザーは管理者1人固定。
**利用者向けの本流フローとは完全に独立した
機能**で、通常の作業では読む必要がない。API側の詳細は
[`apps/api/docs/admin-api.md`](../../api/docs/admin-api.md) を参照。

ルーティング上は`/admin/*`（ja/enどちらのツリーにも属さない独立ルート、日本語固定・
i18n非適用、`React.lazy`で別チャンク）。詳細は `apps/web/README.md`「ルーティング」。

## 1. 認証

SSM Parameter Store（`/sattori/admin/token`）に置いた共有トークンを
`localStorage`（`adminToken.ts`、キー`sattori.adminToken`）に保持し、
`Authorization: Bearer <token>`で送る。API Gateway側のLambda Authorizerが本体の
認可で、フロント側のログインゲート（`AdminApp.tsx`）はUX目的（未ログイン時は
API呼び出し自体を発生させない）。401/403（`AdminUnauthorizedError`、`adminApi.ts`）を
受けた画面は`AdminAuthContext.onUnauthorized`経由で`AdminApp`に伝わり、トークンを
クリアして再ログインを促す。`localStorage`への読み書きは3関数とも`try`/`catch`で
包んである（プライベートブラウジング等で`setItem`が例外を投げると、`/admin`配下に
エラーバウンダリが無いためログイン操作だけで画面が白くなる。セッション限りの
ログインへ縮退させる）。

> 共有トークン方式にした理由は
> [`docs/decisions/0005`](../../../docs/decisions/0005-admin-auth-ssm-shared-token.md)。

## 2. 構成

`AdminApp.tsx`（認証ゲート＋内部`<Routes>`）→ `JobListPage.tsx`（一覧・
status絞り込み・カーソルページング。状態は`useSearchParams`でURLに載せる）／
`JobDetailPage.tsx`（`JobRecord`全フィールド＋ダウンロード導線＋コスト推定＋
ユーザー向けジョブページへのリンク）／`LogsPanel.tsx`（ワーカーログ、Issue #58）／
`CostsPage.tsx`（コスト集計、Issue #60）／
`AnalyticsPage.tsx`（訪問者アナリティクス集計、Issue #149、§7.1）／
`ExecutionPanel.tsx`（Step Functions実行状態、`JobDetailPage`とは別にfetchする。
理由は[`apps/api/docs/admin-api.md`](../../api/docs/admin-api.md)参照）。データ取得は
共通フック`useAdminResource.ts`（`AdminUnauthorizedError`を検知して`onUnauthorized`を
呼ぶ）に集約。

## 3. 操作パネル

（`JobActionsPanel.tsx`、Issue #59）ジョブ詳細画面から緊急停止
（`done`以外のときに活性）と再実行（終端状態かつ未再実行のときのみ活性）を行う。
緊急停止を`failed`でも押せるようにしているのは、ワーカーが`SendTaskFailure`より先に
`failed`を書くため「statusは`failed`なのにステートマシンはリトライ中＝EC2が起動し
続けている」状態がありうるため（[`apps/api/docs/admin-api.md`](../../api/docs/admin-api.md)
参照。停止可否の最終判断はAPI側がStep Functionsの実行状態を見て行い、止めるものが
無ければ409）。逆に再実行は`retriedToJobId`が既にあると押せない（同一リプレイの
二重録画を避けるため。API側も原子的に排他する）。どちらも
取り返しのつかない操作（EC2の強制終了・新規インスタンス起動による課金）なので
`window.confirm`での確認を必須にしている。再実行は**新しいjobIdのジョブ**が作られる
ため、結果メッセージからその詳細画面へのリンクを出す（元ジョブ側の
`retriedToJobId`／新ジョブ側の`retriedFromJobId`フィールドからも相互に辿れる）。
操作後は`useAdminResource`の`reload()`でジョブ詳細を取り直す。`reload()`は
deps変更時と違い取得中も直前の`data`を保持する（パネルが一瞬アンマウントされて
実行結果メッセージが消えるのを避けるため）。

## 4. ユーザー向けジョブページへのリンク

（`JobDetailPage.tsx`）ジョブ詳細から
ページB（`/jobs/{jobId}`、英語のジョブなら`/en/jobs/{jobId}`）を別タブで開ける。
jobId自体が認可の秘密値（`AGENTS.md` §3）なので、管理者もこのURLを開けば
ユーザーとまったく同じ画面を確認できる。同一SPA内だが`<Link>`にすると管理画面から
離脱してしまうため`target="_blank"`にしている。

## 5. ワーカーログ

（`LogsPanel.tsx`、Issue #58）CloudWatch Logs
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

## 6. ワーカー種別（EC2 / 自宅サーバー）による文言の出し分け

（Issue #49）ジョブ詳細の
ワーカー欄・操作パネル・コスト推定・ログの「ストリームが見つからない」説明は
`workerKind`で切り替える。自宅ワーカーのジョブに「EC2インスタンスを強制終了し」
「Spot単価」と出すのは端的に誤りで、停止の効き方（terminateで即座に止まるEC2 /
claim解除にデーモンが気づくまで最大30秒走り続ける自宅ワーカー）も課金の有無も違う。
コスト推定のSpot単価は**自宅ワーカーのジョブでは表示しない**（計算に使われていない
フォールバック定数が「この単価で課金された」と読まれてしまうため）。ただし再実行の
確認文言だけは自宅ワーカーのジョブでもEC2課金に触れる——再実行は`workerKind: null`の
新しいジョブを作るので、割り当ては改めて決まる（`apps/api/src/handlers/admin/retryJob.ts`）。

## 7. コスト表示

（Issue #60）ジョブ詳細の`JobCostPanel.tsx`（1ジョブぶんの内訳）と
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

### 7.1 訪問者アナリティクス表示（`AnalyticsPage.tsx`、`/admin/analytics`、Issue #149）

`GET /admin/analytics`（既定30日・最大90日、`days`クエリパラメータ）の結果を表示する。
ページビュー数・ユニーク訪問者数・パースエラー件数の日別推移（表＋横棒、新しい順）と、
属性別の内訳カード（ページ・参照元・国・言語・デバイス・ブラウザ/OS・UTM流入元・
パースエラー種別・未対応タイトル検出）を並べる。CostsPageと同じくチャートライブラリは
使わず、CSSの横棒（`.barFill`/`.breakdownBarFill`）で比率を示す。

- **「ユニーク訪問（日別合計）」の数字は期間内の実訪問者数ではない**ことを画面下部の
  注記で明示する。ハッシュ化訪問者ID（`visitorHash`）のsaltが日次ローテーションのため
  （`apps/api/README.md`§13、[`docs/decisions/0026`](../../../docs/decisions/0026-hashed-visitor-id-daily-salt.md)）、
  複数日を選ぶとAPIが返す`totals.uniqueVisitorDays`は「日別ユニーク数の単純合計」に
  しかならない。この数字をコストページの「1ジョブ平均」のような確定値と誤読させない
  よう、ラベル自体に「（日別合計）」と添えている。
- 内訳カードの横棒は**カード内の最大値を100%とする相対表示**で、カード間
  （例:「ページ」の棒と「国」の棒）の比較はできない——母数がイベント種別によって
  異なるため（ページ・参照元・デバイス・UTM流入元は`pageview`イベントのみ、
  パースエラー種別・検出タイトルは`parse_error`イベントのみ、国・言語・ブラウザ/OSは
  両方から積み上げる。`apps/api/README.md`§13.1参照）。

## 8. 通貨切り替え

（`adminCurrency.ts` / `costFormat.ts`）コスト表示をUSDと円で
切り替えられる。選択は`AdminLayout`のヘッダーに置き（コスト表示のある画面が複数ある
ため）、`CostCurrencyContext`で配下に配り、`localStorage`に保存する（読み書きは
トークンと同じく`try`/`catch`で握り潰し、既定のUSDへ縮退する）。換算は
`@sattori/shared`の`usdToJpy()`＝固定レートによる概算で、円表示のときだけ
「固定レートによる概算」である旨の注記を出す。円は小数を**USD表示より2桁少なく**
する（$1≒¥157なので、$0.0360→¥5.65、$0.17→¥27で情報量が釣り合う）。

## 9. 設定画面

（`SettingsPage.tsx`、`/admin/settings`、Issue #14）キルスイッチ
（`acceptingNewJobs`）と月間コストガードの上限額（`monthlyCostLimitUsd`）を
管理する。キルスイッチは新規録画の受付を即座に停止・再開するトグルで、
当月の推定コスト（`estimateJobCost()`の月次集計。`CostsPage.tsx`と同じ推定値で
請求額そのものではない）を上限額に対するゲージで表示する。どちらもユーザー向けの
サービス提供可否に直結する変更のため、`JobActionsPanel`と同じ方針で
`window.confirm`による確認を保存前に必須にしている。API側の反映タイミングの
非対称性（キルスイッチは次のリクエストから即反映、月間コストガードの閾値は
ユーザー向け経路のキャッシュにより最大5分遅れる）は`apps/api/README.md`
「キルスイッチ・月間コストガード」参照。

## 10. レイアウト

`AdminLayout.tsx`はユーザー向け`App.tsx`の`Layout`とは共有しない
専用シェル（`LanguageSwitcher`が存在しない`/en/admin`へのリンクを出してしまうことと、
ユーザー向け`main`幅(50rem)がジョブ一覧テーブルには狭すぎることが理由）。CSS Modules
+ `global.css`の既存トークン（`--panel`等）を再利用し、`:root`自体は変更しない。
