# 0018. 自宅ワーカーへの割り当ては Pull 型にし、競合はすべて条件付き更新で決着させる

- **状態**: 有効
- **決定日**: 2026-08（Issue #49 の判断をまとめたもの）
- **対象**: apps/api / home-worker
- **関連**: Issue #49、Issue #59、Issue #87

自宅マシンは NAT 配下で AWS 側から到達できないため、ジョブの割り当ては**自宅が取りに行く
Pull 型**（AWS がオファーを書き、常駐デーモンが条件付き更新で原子的に claim する）にして
ある。**オファーの期限切れと claim の競合は必ず DynamoDB の条件付き更新で決着させること**
——ここを踏み外すと同じリプレイを2台で録画する。

**Pull 型である理由・競合の決着方法をこの1ファイルに集約してある**。
`apps/api/README.md`「自宅ワーカーへのジョブ割り当て」と `home-worker/README.md` は
「今どうなっているか」（① 参照仕様）だけを書き、根拠はここへリンクする。

## 背景

EC2 Spot がコストの7割超を占める（`docs/research/aws-region-cost-analysis.md`）ため、
開発者の自宅サーバーが空いているときはそこで録画させたい。しかし自宅マシンは
**動的グローバルIP・NAT 配下**にあり、AWS 側から到達させるにはポート開放や DDNS が要る。
「オンラインのときだけ使う」という要件とも噛み合わない（Issue #49 の論点1）。

一方、録画ジョブは Step Functions の `Launch` ステート（`waitForTaskToken`）が
「taskToken を持つ主体が結果を返せば成立する」設計になっているので、EC2 ワーカーと
自宅ワーカーはまったく同じインターフェースで扱える。ステートマシン本体・リトライ
ロジック（`apps/api/src/retryPolicy.ts`）は自宅ワーカーの存在を知らない。

## 決定

**Pull 型にする**。AWS 側（`Launch` Lambda）は `JobsTable` にオファーを書くだけで、
自宅デーモンが sparse GSI `HomeWorkerOfferIndex` をポーリングして条件付き更新で原子的に
claim する。流れは `home-worker/README.md`、AWS 側の実装は
`apps/api/src/homeWorker.ts` / `workerRouting.ts` にある。

**タイトルごとの方針**（`routingPolicyFor()`）は次の考えで決めている。

- **th20（Issue #87）だけオファー待ちを上限（`MAX_OFFER_WINDOW_SECONDS`）まで
  伸ばしてある**。他タイトルは「自宅が空いていなければEC2で同じ品質の録画ができる」
  ので待つ価値が薄いが、th20はEC2フォールバック先が`.4xlarge`帯（他タイトルの
  約4倍の単価）で、かつ低速録画（Issue #68）は自宅ワーカーでしかできない。
- **低速録画の要求（`slow-motion-recording`）はタイトルではなくジョブのオプションに
  紐づく**。`job.options.slowMotion` が立っているときだけ `requiredCapabilities` へ
  足す。th20でもユーザーが低速録画を外していれば能力を要求しない——EC2を1台
  起こさずに済むこと自体に価値があるので、不要な条件でオファー先を狭めない。

そのうえで、**割り当てをめぐる競合はすべて DynamoDB の条件付き更新で決着させる**。

- **オファーの撤回は条件付きに行う**（`withdrawHomeWorkerOffer()`）。撤回が条件チェックで
  失敗した（＝待機中に claim された）場合は EC2 を起動しない。期限切れと claim は
  必ずここで決着させること。
- **オファーの書き込みが条件チェックで失敗しても、claim 済みと決めつけない**
  （`handleOfferConflict()`）。`HandleFailure` の割り当て解除は失敗をログだけにして
  `shouldRetry` を返すため、前の試行の `assignedWorkerId` が残ったまま再入することがある。
  これを claim 済みと誤読すると、今回の taskToken を誰も持たないまま15分のタイムアウトを
  待つことになる（リトライ1周が丸ごと無駄になる）。判別は `homeWorkerEnv.TASK_TOKEN` が
  今回のトークンかどうかで行う——**オファーの書き込みがトークンをデーモンへ渡す唯一の
  経路**なので、これが証拠になる。陳腐化していたら割り当てを解除して EC2 へ回す
  （解除は走り続けている古いコンテナを止める手段も兼ねる）。
- **オファー待ちの上限を Lambda のタイムアウトから導く**。待機は `Launch` Lambda の
  実行時間をそのまま消費するため、`offerWindowSeconds` には上限がある
  （`MAX_OFFER_WINDOW_SECONDS` = `LAUNCH_LAMBDA_TIMEOUT_SECONDS` − オファー以外の
  処理ぶんの余裕20秒）。溢れると、オファーは撤回済みなのに EC2 も起動していない状態で
  15分のハートビートタイムアウトを待つ、丸ごと無駄なリトライが1周発生する。Lambda の
  タイムアウトは `@sattori/shared` の `LAUNCH_LAMBDA_TIMEOUT_SECONDS` を唯一の出典にして
  CDK が設定しており、両者の整合はテストで守っている（th20 向けに待機を伸ばすなら
  定数も併せて上げること）。
- **自宅ワーカー経路の不調でユーザーの録画を落とさない**。ハートビートの読み取り・
  オファーの書き込みで想定外の例外が出た場合は握りつぶして EC2 起動へフォールバックする。
  自宅ワーカーはコスト削減のための best-effort な経路に過ぎない。
- **claim の取り消しは「気づかせる」と「気づく前に完走されても壊れない」の二段構え**。
  `assignedWorkerId` が「誰がこのジョブの taskToken を持っているか」の唯一の真実で、
  **AWS 側がこの属性を消すことが claim の取り消し**になる（消す側は
  `sfn/handleFailure.ts` と `admin/stopJob.ts` の2箇所）。取り消しは**同期的ではない**
  （EC2 の `TerminateInstances` と違い、デーモンが次の確認で気づくまでコンテナは走り
  続ける）。その間にコンテナが完走すると `done` と doneAt が書かれ、DynamoDB Streams
  経由で停止したはずのジョブの完了メールがユーザーへ飛ぶため、`admin/stopJob.ts` は
  後始末より**先に** `stopRequestedAt`（`markJobStopRequested()`）を立てる。ワーカー
  （`worker/status.py`）は `attribute_not_exists(stopRequestedAt)` を条件にしか status を
  書けないので、この票が立った後の書き込みは一切通らない。デーモン側の能動的な確認
  （`home-worker/README.md`）と、レコード側の拒否票の二段構えで、どちらが遅れても
  最悪の結果にならないようにしてある。

## 根拠

- **Push 型は到達性の問題を解けない**。NAT 配下の動的 IP へ AWS から接続するには
  ポート開放・DDNS・常時到達性の維持が必要で、「オンラインのときだけ best-effort で
  使う」という位置づけに対して運用コストが釣り合わない。
- **競合の代償が非対称**。オファーの期限切れと claim が競合したときに「両方成立」させると
  **同じリプレイを2台で録画する**（同じ S3 キー・同じジョブレコードを2つのワーカーが書く）。
  逆に「両方不成立」に倒れてもリトライで回復するだけなので、判断は常に条件付き更新へ
  委ね、失敗側は起動しない方へ倒す。
- 停止処理の順序（`stopRequestedAt` を先に立てる）は、claim 取り消しが非同期である以上
  「止めたはずのジョブの完了メールが飛ぶ」ことを他の手段で防げないため。

## 採らなかった選択肢

- **Push 型（AWS から自宅へジョブを送る）**。上記の到達性の問題。VPN や逆トンネルを
  常設する案も、自宅が落ちている平常時のコスト・運用の手間に見合わない。
- **自宅ワーカー専用のキューを別立てする（SQS など）**。ステートマシンから見た
  インターフェース（taskToken）を EC2 と共通にできなくなり、
  「ワーカーの中に自宅か EC2 かの分岐を作らない」方針（`AGENTS.md` §3）が崩れる。
- **claim をアプリ側のロック（読み取り→判定→書き込み）で行う**。オファー撤回との
  競合窓が残り、二重録画を原理的に排除できない。
- **オファー待ちを Step Functions の Wait ステートで表現する**。`Launch` の
  `waitForTaskToken` 契約が複雑になり、EC2 経路との共通化が崩れる。待機20秒程度なら
  Lambda の実行時間で払うほうが単純である。

## 影響範囲

- `apps/api/src/homeWorker.ts` / `workerRouting.ts` / `workerEnv.ts`
- `apps/api/src/handlers/sfn/launch.ts` / `sfn/handleFailure.ts` /
  `handlers/admin/stopJob.ts`（割り当て解除・停止処理の順序）
- `home-worker/`（claim・claim 取り消しの捕捉。`home-worker/README.md`）
- `worker/status.py`（`attribute_not_exists(stopRequestedAt)` 条件）
- `packages/shared`（`LAUNCH_LAMBDA_TIMEOUT_SECONDS`・`HOME_WORKER_OFFER_INDEX` 等）
- `AGENTS.md` §3（Pull 型・ワーカー側に分岐を作らない方針）
