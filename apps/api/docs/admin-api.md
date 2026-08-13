# 管理API（`/admin/*`、Issue #51）

運用調査用の管理画面（`apps/web/src/admin/`）向けAPIの参照仕様。ジョブ一覧・詳細・
ダウンロード導線・Step Functions実行の閲覧・ワーカーログ・緊急停止・再実行・コスト集計を
提供する。**利用者向けの本流フロー（アップロード〜録画〜DL）とは完全に独立しており、
通常の作業では読む必要がない**。フロント側は
[`apps/web/docs/admin-ui.md`](../../web/docs/admin-ui.md) を参照。

ユーザーは管理者1人固定のため、Cognito等ではなくSSM Parameter Store(SecureString)に
置いた共有トークンをLambda Authorizerで検証する方式にしている
（[`docs/decisions/0005`](../../../docs/decisions/0005-admin-auth-ssm-shared-token.md)）。
jobId自体を秘密値として使うユーザー向けの認可方式（`startJob.ts`、
[`0004`](../../../docs/decisions/0004-job-id-as-authorization-secret.md)）とは別系統。

## 目次

- [1. Lambda Authorizer](#1-lambda-authorizer)
- [2. 一覧取得](#2-一覧取得)
- [3. ダウンロード](#3-ダウンロード)
- [4. Step Functions実行](#4-step-functions実行)
- [5. ワーカーログ](#5-ワーカーログ)
- [6. `JobRecord.status`は「実行が終わったか」の代理条件にならない](#6-jobrecordstatusは実行が終わったかの代理条件にならない)
- [7. 緊急停止](#7-緊急停止)
- [8. 再実行](#8-再実行)
- [9. コスト集計](#9-コスト集計)

エンドポイントとハンドラの対応は `apps/api/README.md`「ハンドラ一覧」にある。

## 1. Lambda Authorizer

（`admin/authorizer.ts`、ロジックは`adminAuth.ts`）
REQUEST型・simple response（`{isAuthorized}`）。`identitySource`は
`$request.header.Authorization`のみ（ヘッダー自体が無ければAPI Gatewayが
Lambdaを起動せず401を返す）。トークン比較はSHA-256を経由した固定長の
`timingSafeEqual`（長さ不一致による`RangeError`回避と定数時間比較を両立）。
SSMから取得したトークンは実行コンテキストに5分TTLでキャッシュし、authorizer自体の
`resultsCacheTtl`（5分）と合わせて、トークンローテーション後の失効反映は
**最大10分遅れる**（許容トレードオフ。ローテーション手順は`deploy-sattori` skill）。

## 2. 一覧取得

`JobsTable`はPK`jobId`のみでGSIが無かったため、`StatusCreatedAtIndex`
（PK=`status`, SK=`createdAt`, Projection=ALL）を追加した
（`infra/lib/sattori-stack.ts`）。`status`/`createdAt`は`jobs.ts`の`putJob()`が必ず
設定し、以降の更新経路（`updateJobStatus`等）もSETのみで消えない既存属性のため、
GSI追加だけで既存レコードが自動的にインデックスへ載る（バックフィル不要）。
**`JobRecord`を新規作成する経路を今後追加する場合、`status`/`createdAt`はGSIの
キー属性なので必ず設定すること**（欠けると無言でインデックスから漏れる）。
一覧（`adminJobs.ts`の`listJobs()`）はstatus未指定時、GSIにソートキーが無い
（PKがstatus固定）ため`JOB_STATUSES`ぶん並列にQueryしてcreatedAt降順でk-way
マージする。status遷移中のジョブが複数ストリームに現れうるためjobIdでdedupeする。
status遷移に起因するページを跨いだ重複・欠落は管理画面の性質上許容している。
**カーソルはページ境界の1点ではなく、status毎の再開位置**（そのstatusのGSIクエリの
`ExclusiveStartKey`）を持つ。単一の(createdAt, jobId)を全ストリーム共通の境界にして
`createdAt <= cursor`で絞り込む方式だと、カーソル自身が`Limit`の枠を消費して該当
ストリームが上位limit件を返せなくなり、ページ末尾が別ストリームの遥かに古いアイテムで
埋まる→カーソルが一気に過去へ飛んで**間のジョブが丸ごと欠落する**（`limit=1`では
2ページ目以降が常に空になる）。クエリの`Limit`は`limit + 1`にしている: DynamoDBは
`Limit`到達で打ち切ると後続が無くても`LastEvaluatedKey`を返すため、1件多く要求して
初めて「続きがある」を正確に判定でき、空ページへ進む「次へ」が出なくなる。
カーソルはクライアントに解釈させないよう`base64url(JSON)`の不透明文字列にする。

## 3. ダウンロード

（`downloads.ts`）動画URLの組み立て（`buildVideoDownloadUrl`）は
`getJob.ts`から移設して共有。ユーザー向け`GET /jobs/{jobId}`と異なり、statusが
`done`でなくても`outputPath`/`outputPath720p`があればURLを返す（`converting`中の
生動画チェックポイントを取得したい運用ニーズのため）。**低速録画（Issue #68）の
ジョブでは、`converting`中の`outputPath`が指すのは半分の速度の生データである**
（等倍へ戻すのは変換工程。`worker/README.md` §5）。ユーザー向けの
`GET /jobs/{jobId}`は`done`のときしかURLを返さないのでこれが漏れることはないが、
管理画面で変換中の動画を開いたときは意図した挙動として扱うこと。`.rpy`は`UploadBucket`が
CloudFront配信されていない`BLOCK_ALL`バケットのため、動画とは別にS3署名付き
GET URL（`createPresignedReplayDownloadUrl`、TTL 900秒）を発行する。
配信用変換のffmpeg生ログ（`ffmpegLogUrl`、Issue #58フォローアップ）も同様にS3署名付き
URL（`createPresignedFfmpegLogDownloadUrl`）で配る。CDN配信しないのは一般ユーザー
向け配信物ではないため。S3キー（`worker-logs/{jobId}/ffmpeg-upscale.log`）は
`executionArn`と同じ考え方でjobIdから決定的に導出し（`buildFfmpegUpscaleLogKey`）
DynamoDBには保存しない。`OutputBucket`に短命（3日）なライフサイクルルールを
別途設定している（`infra/lib/sattori-stack.ts`）。

## 4. Step Functions実行

（`admin/getExecution.ts`、`stepFunctions.ts`）
`executionArn`はDBに保存していないが、`startJob.ts`が`StartExecutionCommand`の
実行名にjobIdをそのまま使っているため`buildExecutionArn()`で決定的に導出できる。
実行がまだ存在しない（pendingのまま起動していない）・Standard実行の履歴保持期間
（90日）を過ぎている場合は404にせず`execution: null`を返す（ジョブ自体は存在し、
実行だけが無い状態を素直に表現するため）。同じ理由で`DescribeExecution`と
`GetExecutionHistory`は`allSettled`で切り離し、履歴取得だけが失敗（スロットリング等）
した場合は500にせず`events: []`へ縮退させる（調査で最も有用な実行のstatus/error/cause
は取れているのに画面が真っ白になるのを避けるため）。ジョブ詳細（`admin/getJobDetail.ts`）とは
意図的に別エンドポイントにしている: SFNが不調でも詳細画面はDynamoDB由来の情報だけで
描画できるべきで、詳細用Lambdaに`states:*`権限を持たせずに済む（最小権限）。

## 5. ワーカーログ

（`admin/getLogs.ts`、Issue #58）ロググループは固定
（`/sattori/worker`、環境変数`WORKER_LOG_GROUP`）、ログストリーム名は`jobId`
（`ec2.ts`の`buildUserData()`が`docker run --log-opt awslogs-stream=${job.jobId}`
で対応させる）ため、`GetLogEvents`をそのまま呼べる。新しい方から`limit`件取得し、
`?cursor=`にレスポンスの`nextBackwardToken`を渡すことで古いイベントへページングする
（`nextBackwardToken`が要求時の`cursor`と一致 or 0件なら「これ以上古いイベントは無い」
としてnullへ縮退させる）。Step Functionsのリトライ（最大10回）を跨いでも同じ
ストリームに追記されるため、複数回の試行ログが混在しうる点はフロント側で注記する。
ログストリームが存在しない（`ResourceNotFoundException`）場合、UserData(bootstrap)
段階の失敗（ECRログイン/pull失敗等、コンテナが一度も起動できなかった）を疑い、
クエリパラメータで渡された`instanceId`を使って`GetConsoleOutput`にフォールバックする。
`instanceId`はDynamoDBの情報だが、`getExecution.ts`と同じ最小権限の考え方でこの
LambdaにはjobsTable読み取り権限を持たせず、既に`GET /admin/jobs/{jobId}`を叩いている
フロントからクエリパラメータで受け取る。インスタンスが終了済みだと出力が取得できず
`consoleOutput: null`に縮退することがある（500にはしない）。
当初、配信用変換の`worker/convert.py`（当時は`upscale.py`）がffmpegの`-progress`生出力（frame=/fps=/
bitrate=等）を全行このログストリームへ流していたが、1ジョブで数千行に達し
実機の管理画面で他のログを埋もれさせる問題が判明した。クライアント側フィルタ
（後述）だけでは`GetLogEvents`のページ自体がノイズで埋まる問題は解決しないため、
最終的にworker側でCloudWatchへ送らずファイル退避＋S3アップロードに変更した
（`downloads.ts`の`ffmpegLogUrl`、`worker/README.md`参照）。以前のジョブ・
ワーカーイメージ再デプロイ前のログには依然ノイズが残るため、フロント
（`LogsPanel.tsx`）側の「`[ffmpeg] `を含む行を既定で非表示にする」フィルタは
後方互換のため残している。

## 6. `JobRecord.status`は「実行が終わったか」の代理条件にならない

（停止・再実行の両方に効く前提）。ワーカーは内部エラー時に`SendTaskFailure`より先に
`status: "failed"`を書き（`worker/entrypoint.py`）、ステートマシンはその後
`WaitBeforeCheck`（3分）を挟んで`HandleFailure`へ進み、`attempt < MAX_ATTEMPTS`
なら`Launch`をやり直す（`handleFailure.ts`は`status === "done"`のときしか
中断しない）。つまり**DynamoDB上は終端状態なのに実行は生きていて、新しいEC2を
起動し続ける**窓が毎回ある。停止・再実行の可否は`stepFunctions.ts`の
`getExecutionLiveness()`（`DescribeExecution`）で判定する。

## 7. 緊急停止

（`admin/stopJob.ts`、Issue #59）「ジョブが終端状態」**かつ**
「実行も生きていない」場合のみ409。逆に言えば`failed`でも実行が`RUNNING`なら
停止でき（上記のリトライ暴走を止めるのが本機能の主目的）、非終端のまま固まった
ジョブも停止（＝`failed`確定）できる。`DescribeExecution`自体が失敗して判定不能な
場合は「止められる余地がある」側に倒して停止処理へ進む。
**(1) `StopExecution` → (2) `TerminateInstances` → (3)
`updateJobStatus(failed)` の順序が重要**で、先にインスタンスをterminateすると
taskToken応答が来なくなった実行がタスクタイムアウト（150分）後に`HandleFailure`
経由でリトライへ回り、**止めたはずのジョブが別インスタンスで再起動してしまう**。
各段階の失敗はそこで打ち切って502を返し、ジョブ状態は書き換えない（実際には
止まっていないのに`failed`と表示されるのが最も危険なため）。`StopExecution`は
停止済み実行に対しても成功する冪等なAPIなので、管理者はそのまま再実行できる。
実行がまだ存在しない（pendingのまま起動していない）場合は`ExecutionDoesNotExist`
を握りつぶして`executionStopped: false`で先へ進む。
terminate対象は`JobRecord.instanceId`だけでなく**タグ`sattori:jobId`からも探す**
（`ec2.ts`の`findJobInstanceIds()`）。instanceIdはLaunch Lambdaが`CreateFleet`の
**後**に書き込むため、起動直後のジョブではDynamoDBを読んだ時点で未記録のことがあり
（Step Functionsは実行中のLambda呼び出しをキャンセルしない）、取り逃すと孤児
インスタンスが最大150分課金され続ける。最後の`failed`確定は`status`が`done`でない
ことを条件にした原子的更新にしている（停止処理中にワーカーが完走し、完了メールまで
飛んだのに画面は`failed`という食い違いを避けるため。この場合レスポンスの`status`は
`done`になる）。

> 自宅ワーカーのジョブでは claim の取り消しが同期的ではないため、後始末より先に
> `stopRequestedAt` を立てる。理由は
> [`docs/decisions/0018`](../../../docs/decisions/0018-home-worker-pull-assignment.md)。

## 8. 再実行

（`admin/retryJob.ts`、Issue #59）**同一jobIdでは再実行しない**。
`startPendingJob()`は「statusがpendingであること」を条件にした原子的更新が前提で、
Step Functionsの実行名もjobIdそのものを使っている（同名の`StartExecution`は
`ExecutionAlreadyExists`になりうる）ため、既存の冪等性前提を壊さないよう
**新しいjobIdでジョブレコードを複製して起動する**。複製の内訳は`buildRetryJob()`
（入力側＝`replayKey`/`game`/`options`/`email`/`language`等を引き継ぎ、結果側＝
出力パス・進捗・インスタンス情報・エラーを初期化。`status`はマジックリンク確認済み
のため`pending`を経由せず`queued`から開始）。
**二重録画（＝EC2の二重課金）を防ぐガードは3段**: (1) 元ジョブのstatusが終端で
あること、(2) 元ジョブのStep Functions実行が動いていないこと（statusが`failed`でも
リトライループの最中でありうるため。判定不能な場合は安全側＝502で中止）、
(3) まだ再実行していないこと（`claimJobRetryLink()`による原子的な予約。二重クリック
やリクエスト再送でクローンが2本走ると、片方は元ジョブから辿れない追跡不能な
ジョブになる）。EC2を起動する前に元の`.rpy`が`UploadBucket`に残っているかを
`objectExistsStrict()`で確認する（404以外の失敗を「削除済み」と誤報して運用者を
誤った原因調査へ誘導しないよう、一時障害は502として区別する）。元ジョブには
`retriedToJobId`、新ジョブには`retriedFromJobId`を記録して相互に辿れるようにする
（`retriedToJobId`は上記(3)の排他を兼ねるため**ジョブレコードを作る前**に予約し、
`StartExecution`に失敗したら`releaseJobRetryLink()`で取り消す。取り消さないと
以後の再実行が永久に409で弾かれてしまう）。
完了メールは新ジョブが`done`に遷移した時点で引き継いだ`email`宛に届き、本文の
リンクも新jobIdのジョブページになる（ユーザーは古いマジックリンクのままでも
新しいメールから辿れる）。

## 9. コスト集計

（`admin/getCosts.ts`、`adminCosts.ts`、Issue #60）ジョブ単位の
コスト推定（`@sattori/shared`の`estimateJobCost()`。単価・モデルの詳細は
`packages/shared/README.md`「コスト推定」）を日次/週次/月次で積み上げて返す。
**`JobsTable`の素朴な全件Scan + アプリ側集計**で、集計結果テーブルもAthena等の
分析基盤も持たない。想定規模は月1000ジョブでTTLも無いため1年運用しても1万件強に
しかならず、「増えたら考える」ほうが総コストが低いという判断（Issue #60の設計メモ）。
`StatusCreatedAtIndex`を使わないのは、GSIのPKが`status`固定で全ステータス横断の
期間クエリにならず、7本のQueryを束ねても結局全件読むことになるため。件数に比例して
実行時間が伸びるので、このLambdaだけタイムアウト60秒・メモリ512MBに広げてある。
バケットの基準時刻は`launchedAt ?? createdAt`（＝コストが発生した時刻。`createdAt`は
マジックリンク送信要求の時点なので、日付をまたいで起動されたジョブでは1日ずれる）。
バケットのキーは**すべてUTC**で作る（AWSの請求自体がUTC日付区切りなので、
ローカルタイムゾーンを持ち込まないほうが請求書と突き合わせやすい）。
CloudFrontの配信料だけは`granularity`によらず常に月次で返す——無料枠1TB/月が
アカウント単位・月単位でしか判定できず、日次・週次バケットへは原理的に配分できない。
レスポンスには`quality`（フォールバックを使ったジョブ数）を含める。コスト算出用
フィールドはIssue #60で追加したもので**それ以前のジョブは値を持たない**ため、
「表示中の数字にどれだけ仮定が混ざっているか」を画面に出せないと、運用者が推定値を
実績として読んでしまう。
