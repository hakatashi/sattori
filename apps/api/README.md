# apps/api

Lambda ハンドラ群（AWS API Gateway HTTP API 経由）。S3署名URL発行・リプレイ解析・
マジックリンク送信・ジョブ起動・状態取得・完了メール送信・Step Functions連携を担う。
API契約自体は `packages/shared/README.md` を参照。

## ハンドラ一覧（`src/handlers/`）

| ファイル | エンドポイント / トリガー | 役割 |
| --- | --- | --- |
| `createUpload.ts` | `POST /uploads` | `.rpy` アップロード用の署名付きPUT URLを発行（ファイル本体はLambdaを経由しない） |
| `parseReplay.ts` | `POST /replays/parse` | アップロード済みリプレイを取得し `@sattori/shared` の `parseReplayInfo()` で解析 |
| `requestMagicLink.ts` | `POST /magic-links` | レート制限チェック→`status: "pending"`の`JobRecord`作成→SESでマジックリンク送信。メール送信自体が失敗したらジョブを削除してロールバックする |
| `startJob.ts` | `POST /jobs/{jobId}/start` | `pending`→`queued`への原子遷移＋Step Functions `StartExecution` |
| `getJob.ts` | `GET /jobs/{jobId}` | ジョブ状態取得。完了時はCloudFrontのダウンロードURLを組み立てる |
| `sendCompletionEmail.ts` | JobsTableのDynamoDB Streams | ジョブが`done`に遷移した瞬間を検知しSESで完了メール送信 |
| `sfn/launch.ts` | Step Functions `Launch`タスク | EC2 Fleetでワーカーを1台起動（`waitForTaskToken`。成否確定はワーカー自身が行う） |
| `sfn/handleFailure.ts` | Step Functions `HandleFailure`タスク | 孤児インスタンスをterminateしつつリトライ可否を判定 |
| `admin/authorizer.ts` | `/admin/*` の Lambda Authorizer | 共有トークンの検証（後述「管理API」） |
| `admin/listJobs.ts` | `GET /admin/jobs` | ジョブ一覧（新しい順・status絞り込み・カーソルページング） |
| `admin/getJobDetail.ts` | `GET /admin/jobs/{jobId}` | `JobRecord`全フィールド＋ダウンロード導線 |
| `admin/getExecution.ts` | `GET /admin/jobs/{jobId}/execution` | Step Functions実行の状態・履歴 |
| `admin/getLogs.ts` | `GET /admin/jobs/{jobId}/logs` | ワーカーコンテナのCloudWatch Logs（見つからない場合はEC2コンソール出力にフォールバック） |
| `admin/stopJob.ts` | `POST /admin/jobs/{jobId}/stop` | 暴走ジョブの緊急停止（実行停止→インスタンス終了→`failed`確定） |
| `admin/retryJob.ts` | `POST /admin/jobs/{jobId}/retry` | 失敗ジョブの再実行（**新しいjobId**へ複製して起動） |

## ジョブ起動〜Step Functionsの流れ

1. `startJob.ts` が `pending`→`queued` への遷移をDynamoDBの条件付き更新で原子的に
   行い（`jobs.ts` の `startPendingJob()`、`ConditionExpression: "#s = :pending"`）、
   Step Functions の実行を開始する（`attempt: INITIAL_ATTEMPT`、`retryPolicy.ts`）。
   条件不成立（既に起動済み）なら `JobAlreadyStartedError` を捕まえて現在の状態を
   冪等に返すだけで、Step Functionsは再起動しない。
2. `sfn/launch.ts`（`waitForTaskToken`パターン、タスクタイムアウト60分）が
   `launchRecordingInstance()`（`ec2.ts`）でEC2 Fleetを1台起動し、ジョブを
   `launching` に更新する。**このハンドラの戻り値はStep Functionsの実行結果に
   影響しない** — 成功/失敗の確定はワーカー自身が`taskToken`経由で
   `SendTaskSuccess`/`SendTaskFailure`を呼ぶことで行う。
3. Spot中断・タイムアウト等で失敗すると、3分の待機（インフラ側の`WaitBeforeCheck`。
   Spot中断の早期失敗通知はワーカーの処理継続中に送られるため、即座に判定せず
   猶予を置く）を挟んで `sfn/handleFailure.ts` が呼ばれる。ジョブが待機中に
   `done` へ遷移していれば何もしない。未完了なら孤児化した可能性のあるインスタンスを
   `terminateInstance()` し、`retryPolicy.ts` の `MAX_ATTEMPTS`（**10回**）未満なら
   `shouldRetry: true` を返してリトライ、上限に達していればジョブを `failed` に確定する
   （ワーカー自身が既に`failed`を書き込んでいれば上書きしない）。
4. `handleFailure.ts` 自体がAWS APIの一時的な障害で例外を投げても、ジョブが
   非終端状態のまま固まらないよう、インフラ側でリトライ＋最終的な`Fail`遷移が
   用意されている（`infra/README.md`参照）。

## EC2 Fleet インスタンスタイプの分散配置（`ec2.ts`, Issue #29）

単一インスタンスタイプのみだとそのハードウェアプールが時間帯によって枯渇し
`InsufficientInstanceCapacity` で起動自体が失敗する事例が発生したため、
サブネット（=AZ）×候補インスタンスタイプの全組み合わせを `CreateFleet` の
`Overrides` に渡し、`AllocationStrategy: "price-capacity-optimized"`
（`SingleInstanceType: false`）で配置する。

- **th06/07/08向け**（`DEFAULT_CANDIDATE_INSTANCE_TYPES`）: `c7i.xlarge` /
  `c7a.xlarge` / `c6a.xlarge` / `c6i.xlarge` / `c7i-flex.xlarge` / `c5a.xlarge`。
  touhou-recorder `reports/27` で th08 の重複フレーム率を実測検証（いずれも
  1〜4%台の良好な値）した上で選定した6タイプ。
- **th11専用**（`TH11_CANDIDATE_INSTANCE_TYPES`）: `c6i.2xlarge` / `c6a.2xlarge` /
  `c7i.2xlarge` / `c7a.2xlarge`。th11は`.xlarge`帯(4vCPU)だとステージ後半で
  深刻な処理落ち（コマ落ちではなくゲームプレイ自体の実時間伸長）が本番で発生し、
  touhou-recorder `reports/40` の実機検証で原因はvCPU数不足と判明。8vCPU/16GiB以上
  (`.2xlarge`帯)にすると重複フレーム率が明確に改善する。コスト影響は`.xlarge`比で
  概ね2倍。`c6a.2xlarge`/`c7a.2xlarge`は`reports/40`では未検証（検証済みは
  `c6i.2xlarge`/`c7i.2xlarge`のみ）で、本番運用の中で注視が必要。

**インスタンスタイプの変更は録画品質（重複フレーム率）に直結するリスクがあり、
「同スペック帯・同価格帯だから安全」とは限らない**（`z1d.xlarge`は高クロック特化
ゆえに悪化した実績がある）。追加候補を投入する際は必ず同様の実機検証を経ること。

`CreateFleet`が実際に確保したインスタンスタイプ・AZは `result.Instances[0]` から
そのまま取得でき、追加の`DescribeInstances`呼び出しは不要。`JobRecord.instanceType`/
`.availabilityZone`として記録する（`jobs.ts`の`updateJobInstance()`）。これは録画品質の
分析・運用調査用の内部データで、ユーザー向けAPI（`GetJobResponse`）には含めない。

## ワーカー起動スクリプト（UserData, `ec2.ts` の `buildUserData()`）

ベースの Launch Template（AMI/IAM/SGはCDK側で固定）に対し、ジョブ固有のUserDataのみを
持つ新しいバージョンを`CreateLaunchTemplateVersion`で作成してから`CreateFleet`する。
UserDataスクリプトの要点:

- ECS最適化AMIは常駐ECSエージェントがCPUを消費し、高負荷区間でffmpegのx11grab
  キャプチャとコンテンションを起こして重複フレーム率を悪化させるため（八雲藍戦で
  15-26%→4.8%に改善した実測あり）、`systemctl disable --now ecs`で停止しプレーンな
  dockerホストとして使う。
- `trap 'shutdown -h now' EXIT` で、ECRログイン・pull・docker実行のどこで失敗しても
  必ずインスタンスを終了させる（孤児防止、課金停止）。
- コンテナが一度も起動できないまま(ECRログイン/pull失敗等)shutdownすると、ワーカー
  内部(`entrypoint.py`)のtaskToken通知が一切実行されずStep Functionsが60分タイムアウト
  するまでジョブが「起動中」のまま停滞する事故が過去に発生したため、コンテナ起動前
  段階の失敗はUserData自身が`aws stepfunctions send-task-failure`で即座に通知する。

## マジックリンク送信・レート制限（`requestMagicLink.ts`, `rateLimit.ts`）

- 同一メール（`+`エイリアス正規化後、`normalizeEmailForRateLimit()`）は24時間5件まで
  （`RATE_LIMIT_MAX_REQUESTS_PER_DAY`）。判定と記録を`EmailRateLimitTable`への条件付き
  `UpdateCommand`1回に一本化して原子的に行う（旧実装のQuery→Put 2段階では、間隙に
  同時到着したリクエスト同士が互いのカウントを見落とす競合状態があった）。固定
  ウィンドウ方式（「そのメールで最初にカウントされた時刻から24時間」）で、厳密な
  スライディングウィンドウではないがこの規模のサービスには十分という判断。
- ジョブは`status: "pending"`で作成されるが、Step Functionsはまだ起動しない
  （`POST /jobs/{jobId}/start`で初めて起動）。メール送信自体が失敗した場合は
  作成したジョブを削除してロールバックする（誰もアクセスできないジョブを残さない）。
- `pending`ジョブの受付期限は24時間（`jobs.ts`の`PENDING_JOB_TTL_MS`。bot/濫用対策で、
  アップロード用S3の保持期間とは独立）。

## ダウンロードURLとContent-Disposition（`getJob.ts`）

動画ダウンロードはブラウザ標準のダウンロード機構（進捗表示・タブを離れても継続・
ディスクへの直接ストリーミング）に任せる設計。S3のGetObject APIは
`response-content-disposition`クエリパラメータの値をそのまま`Content-Disposition`
レスポンスヘッダーへエコーバックする仕様を持つため、`getJob.ts`の`buildDownloadUrl()`
がこのクエリ（値の組み立ては`packages/shared/src/download.ts`）を含めて
`downloadUrl`/`downloadUrl720p`を返すだけで、フロントエンド側は単純な
`<a href={...} download>`でよく、fetch+Blob化もCORS許可も不要になる。CloudFront側は
このクエリをオリジンへ転送しキャッシュキーにも含める専用の`CachePolicy`を使う
（含めないと720p/オリジナル解像度など異なるファイル名のリクエスト間でキャッシュが
混線する。`infra/README.md`参照）。

## 管理API（`/admin/*`、Issue #51）

運用調査用の管理画面（`apps/web/src/admin/`）向け。ユーザーは管理者1人固定のため、
Cognito等ではなくSSM Parameter Store(SecureString)に置いた共有トークンを
Lambda Authorizerで検証する方式にしている。jobId自体を秘密値として使う
ユーザー向けの認可方式（`startJob.ts`、AGENTS.md）とは別系統。

- **一覧取得**: `JobsTable`はPK`jobId`のみでGSIが無かったため、`StatusCreatedAtIndex`
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
- **Lambda Authorizer**（`admin/authorizer.ts`、ロジックは`adminAuth.ts`）:
  REQUEST型・simple response（`{isAuthorized}`）。`identitySource`は
  `$request.header.Authorization`のみ（ヘッダー自体が無ければAPI Gatewayが
  Lambdaを起動せず401を返す）。トークン比較はSHA-256を経由した固定長の
  `timingSafeEqual`（長さ不一致による`RangeError`回避と定数時間比較を両立）。
  SSMから取得したトークンは実行コンテキストに5分TTLでキャッシュし、authorizer自体の
  `resultsCacheTtl`（5分）と合わせて、トークンローテーション後の失効反映は
  **最大10分遅れる**（許容トレードオフ。ローテーション手順は`CLAUDE.local.md`）。
- **ダウンロード**（`downloads.ts`）: 動画URLの組み立て（`buildVideoDownloadUrl`）は
  `getJob.ts`から移設して共有。ユーザー向け`GET /jobs/{jobId}`と異なり、statusが
  `done`でなくても`outputPath`/`outputPath720p`があればURLを返す（`converting`中の
  生動画チェックポイントを取得したい運用ニーズのため）。`.rpy`は`UploadBucket`が
  CloudFront配信されていない`BLOCK_ALL`バケットのため、動画とは別にS3署名付き
  GET URL（`createPresignedReplayDownloadUrl`、TTL 900秒）を発行する。
  720p変換のffmpeg生ログ（`ffmpegLogUrl`、Issue #58フォローアップ）も同様にS3署名付き
  URL（`createPresignedFfmpegLogDownloadUrl`）で配る。CDN配信しないのは一般ユーザー
  向け配信物ではないため。S3キー（`worker-logs/{jobId}/ffmpeg-upscale.log`）は
  `executionArn`と同じ考え方でjobIdから決定的に導出し（`buildFfmpegUpscaleLogKey`）
  DynamoDBには保存しない。`OutputBucket`に短命（3日）なライフサイクルルールを
  別途設定している（`infra/lib/sattori-stack.ts`）。
- **Step Functions実行**（`admin/getExecution.ts`、`stepFunctions.ts`）:
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
- **ワーカーログ**（`admin/getLogs.ts`、Issue #58）: ロググループは固定
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
  当初、720p変換の`worker/upscale.py`がffmpegの`-progress`生出力（frame=/fps=/
  bitrate=等）を全行このログストリームへ流していたが、1ジョブで数千行に達し
  実機の管理画面で他のログを埋もれさせる問題が判明した。クライアント側フィルタ
  （後述）だけでは`GetLogEvents`のページ自体がノイズで埋まる問題は解決しないため、
  最終的にworker側でCloudWatchへ送らずファイル退避＋S3アップロードに変更した
  （`downloads.ts`の`ffmpegLogUrl`、`worker/README.md`参照）。以前のジョブ・
  ワーカーイメージ再デプロイ前のログには依然ノイズが残るため、フロント
  （`LogsPanel.tsx`）側の「`[ffmpeg] `を含む行を既定で非表示にする」フィルタは
  後方互換のため残している。
- **`JobRecord.status`は「実行が終わったか」の代理条件にならない**（停止・再実行の
  両方に効く前提）。ワーカーは内部エラー時に`SendTaskFailure`より先に
  `status: "failed"`を書き（`worker/entrypoint.py`）、ステートマシンはその後
  `WaitBeforeCheck`（3分）を挟んで`HandleFailure`へ進み、`attempt < MAX_ATTEMPTS`
  なら`Launch`をやり直す（`handleFailure.ts`は`status === "done"`のときしか
  中断しない）。つまり**DynamoDB上は終端状態なのに実行は生きていて、新しいEC2を
  起動し続ける**窓が毎回ある。停止・再実行の可否は`stepFunctions.ts`の
  `getExecutionLiveness()`（`DescribeExecution`）で判定する。
- **緊急停止**（`admin/stopJob.ts`、Issue #59）: 「ジョブが終端状態」**かつ**
  「実行も生きていない」場合のみ409。逆に言えば`failed`でも実行が`RUNNING`なら
  停止でき（上記のリトライ暴走を止めるのが本機能の主目的）、非終端のまま固まった
  ジョブも停止（＝`failed`確定）できる。`DescribeExecution`自体が失敗して判定不能な
  場合は「止められる余地がある」側に倒して停止処理へ進む。
  **(1) `StopExecution` → (2) `TerminateInstances` → (3)
  `updateJobStatus(failed)` の順序が重要**で、先にインスタンスをterminateすると
  taskToken応答が来なくなった実行がタスクタイムアウト（90分）後に`HandleFailure`
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
  インスタンスが最大90分課金され続ける。最後の`failed`確定は`status`が`done`でない
  ことを条件にした原子的更新にしている（停止処理中にワーカーが完走し、完了メールまで
  飛んだのに画面は`failed`という食い違いを避けるため。この場合レスポンスの`status`は
  `done`になる）。
- **再実行**（`admin/retryJob.ts`、Issue #59）: **同一jobIdでは再実行しない**。
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

## 環境変数（`config.ts`）

すべて `infra/lib/sattori-stack.ts` の `commonEnv`（+ `startJob.ts`/
`admin/getExecution.ts`/`admin/stopJob.ts`/`admin/retryJob.ts`専用の
`STATE_MACHINE_ARN`、`admin/authorizer.ts`専用の
`ADMIN_TOKEN_PARAMETER_NAME`、`admin/getLogs.ts`専用の`WORKER_LOG_GROUP`単独指定）
から注入される。`loadConfig()`が必須環境変数の存在を
検証する（管理API用Lambdaは`commonEnv`を使わず個別の環境変数のみを持つ）。

`STATE_MACHINE_ARN`が`commonEnv`に含まれない理由: ステートマシンは`launchFn`/
`handleFailureFn`（Lambda ARN）を呼び出すため、これらのLambdaの環境変数がステート
マシンARNを参照するとCloudFormationの循環依存になる。`StartExecution`/`DescribeExecution`
系を呼ぶ`startJob.ts`・`admin/getExecution.ts`だけが個別の環境変数として受け取る。

## テスト

各ハンドラに対応する `*.test.ts` が同ディレクトリにある（vitest、AWS SDKクライアントは
モック）。`pnpm --filter @sattori/api test` で実行。
