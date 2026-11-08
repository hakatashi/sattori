# apps/api

Lambda ハンドラ群（AWS API Gateway HTTP API 経由）。S3署名URL発行・リプレイ解析・
マジックリンク送信・ジョブ起動・状態取得・完了メール送信・Step Functions連携を担う。
API契約自体は `packages/shared/README.md` を参照。**ここには「今どうなっているか」だけを
書く** —— なぜそうしたかの根拠は [`docs/decisions/`](../../docs/decisions/README.md)、
管理API（`/admin/*`）の詳細は [`docs/admin-api.md`](docs/admin-api.md)、EC2の起動・孤児掃除・
環境変数の詳細は [`docs/`](docs/) 配下（各節からリンク）にある。

## 目次

- [1. ハンドラ一覧（`src/handlers/`）](#1-ハンドラ一覧srchandlers)
- [2. ジョブ起動〜Step Functionsの流れ](#2-ジョブ起動step-functionsの流れ)
- [3. 自宅ワーカーへのジョブ割り当て](#3-自宅ワーカーへのジョブ割り当てhomeworkerts--workerroutingts-issue-49)
- [4. EC2 Fleet インスタンスタイプの分散配置](#4-ec2-fleet-インスタンスタイプの分散配置ec2ts-issue-29)
- [5. 孤児インスタンスの検知](#5-孤児インスタンスの検知orphaninstancests--handlerssweeporphaninstancests-issue-23)
- [6. ワーカーコンテナの環境変数（`workerEnv.ts`）](#6-ワーカーコンテナの環境変数workerenvts)
- [7. ワーカー起動スクリプト（UserData）](#7-ワーカー起動スクリプトuserdata-ec2ts-の-builduserdata)
- [8. マジックリンク送信・レート制限](#8-マジックリンク送信レート制限requestmagiclinkts-ratelimitts)
- [9. キルスイッチ・月間コストガード](#9-キルスイッチ月間コストガードsettingsts-costguardts-issue-14)
- [10. ダウンロードURLとContent-Disposition（`getJob.ts`）](#10-ダウンロードurlとcontent-dispositiongetjobts)
- [11. 管理API（`/admin/*`、Issue #51）](#11-管理apiadminissue-51)
- [12. 環境変数（`config.ts`）](#12-環境変数configts)
- [13. 計測（アナリティクス、`POST /beacon`、Issue #142）](#13-計測アナリティクスpost-beaconissue-142)
- [14. テスト](#14-テスト)

## 1. ハンドラ一覧（`src/handlers/`）

| ファイル | エンドポイント / トリガー | 役割 |
| --- | --- | --- |
| `createUpload.ts` | `POST /uploads` | `.rpy` アップロード用の署名付きPUT URLを発行（ファイル本体はLambdaを経由しない）。`size`は`MAX_REPLAY_BYTES`以下の整数であることを検証したうえで署名の`ContentLength`に使うため、実際のPUTのバイト数がこの値と一致しないとS3が拒否する（Issue #128 SEC-2） |
| `parseReplay.ts` | `POST /replays/parse` | アップロード済みリプレイを取得し `@sattori/shared` の `parseReplayInfo()` で解析。同じロジックはブラウザでも直接動くため（`apps/web/README.md`「ページAのフロー」参照）、現在のページAはこのAPIを呼ばず解析をクライアント内で完結させている。将来他のクライアント（管理画面の再解析等）が使う可能性を見込んで残してある |
| `requestMagicLink.ts` | `POST /magic-links` | レート制限チェック→`status: "pending"`の`JobRecord`作成→SESでマジックリンク送信。メール送信自体が失敗したらジョブを削除してロールバックする |
| `startJob.ts` | `POST /jobs/{jobId}/start` | `pending`→`queued`への原子遷移＋Step Functions `StartExecution`。`queued`のまま実行が`absent`なら張り直す（[Issue #132対応](../../docs/decisions/0031-stalled-job-sweep-by-status.md)） |
| `getJob.ts` | `GET /jobs/{jobId}` | ジョブ状態取得。完了時はCloudFrontのダウンロードURL・プレビュー再生URLを組み立てる |
| `sendCompletionEmail.ts` | JobsTableのDynamoDB Streams | ジョブが`done`に遷移した瞬間を検知しSESで完了メール送信 |
| `sweepOrphanInstances.ts` | EventBridgeのスケジュールルール（10分間隔） | 孤児化した録画EC2インスタンスの定期掃除（Issue #23。§5） |
| `sweepStalledJobs.ts` | 同上（同じRuleに相乗り） | 非終端のまま固まったジョブレコードを`failed`へ確定する定期掃除（[Issue #132対応](../../docs/decisions/0031-stalled-job-sweep-by-status.md)） |
| `sfn/launch.ts` | Step Functions `Launch`タスク | EC2 Fleetでワーカーを1台起動（`waitForTaskToken`。成否確定はワーカー自身が行う） |
| `sfn/handleFailure.ts` | Step Functions `HandleFailure`タスク | 孤児インスタンスをterminateしつつリトライ可否を判定 |
| `admin/authorizer.ts` | `/admin/*` の Lambda Authorizer | 共有トークンの検証（[`docs/admin-api.md`](docs/admin-api.md)） |
| `admin/listJobs.ts` | `GET /admin/jobs` | ジョブ一覧（新しい順・status絞り込み・カーソルページング） |
| `admin/getJobDetail.ts` | `GET /admin/jobs/{jobId}` | `JobRecord`全フィールド＋ダウンロード導線 |
| `admin/getExecution.ts` | `GET /admin/jobs/{jobId}/execution` | Step Functions実行の状態・履歴 |
| `admin/getLogs.ts` | `GET /admin/jobs/{jobId}/logs` | ワーカーコンテナのCloudWatch Logs（見つからない場合はEC2コンソール出力にフォールバック） |
| `admin/stopJob.ts` | `POST /admin/jobs/{jobId}/stop` | 暴走ジョブの緊急停止（実行停止→インスタンス終了→`failed`確定） |
| `admin/retryJob.ts` | `POST /admin/jobs/{jobId}/retry` | 失敗ジョブの再実行（**新しいjobId**へ複製して起動） |
| `admin/getCosts.ts` | `GET /admin/costs` | コスト推定の日次/週次/月次集計（全件Scan + アプリ側集計）。CloudFrontの月次配信量はジョブ単位推定に加えCloudWatch実測値も併記（Issue #163） |
| `admin/getAnalytics.ts` | `GET /admin/analytics` | 訪問者アナリティクスの日別集計（ユニーク訪問者数・ページビュー数・パースエラー件数・属性別内訳、Issue #149。§13） |
| `admin/getSettings.ts` | `GET /admin/settings` | キルスイッチ・月間コストガード閾値の現在値と当月推定コストを取得（Issue #14） |
| `admin/updateSettings.ts` | `POST /admin/settings` | キルスイッチ・月間コストガード閾値の更新（Issue #14） |
| `recordAnalyticsEvent.ts` | `POST /beacon` | Cookie無しの計測ビーコンの受け口。pageview/parse_errorイベントを`AnalyticsEventsTable`へ記録する（Issue #142。§13） |

## 2. ジョブ起動〜Step Functionsの流れ

1. `startJob.ts` が `pending`→`queued` への遷移をDynamoDBの条件付き更新で原子的に
   行い（`jobs.ts` の `startPendingJob()`、`ConditionExpression: "#s = :pending"`）、
   Step Functions の実行を開始する（`attempt: INITIAL_ATTEMPT`、`retryPolicy.ts`）。
   条件不成立（既に起動済み）なら `JobAlreadyStartedError` を捕まえて現在の状態を
   冪等に返すだけで、Step Functionsは再起動しない。
2. **`sfn/acquireGpuSlot.ts`**（GPU vCPU容量リース、Issue #270）が最初に呼ばれる。
   GPU必須のジョブ（th06nc・th15・th20と倍速録画、`requiresGpuRecording(job)`）のみ`GpuSlotsTable`でvCPU容量を会計し、
   空きが無ければ`WaitForGpuSlot`（アダプティブな間隔）を挟んで自分自身へ戻る
   ループを回す。投入順（FIFO）は`JobsTable`のsparse GSI`GpuQueueIndex`
   （PK=`gpuQueueState`, SK=`gpuQueuedAt`）で守り、列の先頭でなければ枠取りを
   試みない（`apps/api/src/gpuQueue.ts`）。心拍（`gpuQueueHeartbeatAt`）が陳腐化
   した待機者は先頭判定から除外する（head-of-line blocking対策）。非GPUジョブは
   `GpuSlotsTable`にも`gpuQueue*`属性にも一切触れず即座に通過する。詳細・設計根拠は
   [`0056`](../../docs/decisions/0056-gpu-vcpu-lease-and-queue.md)。
   速度を落とせるジョブ（`fallbackRecordingSpeedFor()`: 倍速録画は等倍、th15・th20はCPU低速）は、30分以上待ったら
   `options.recordingSpeed`を書き換えて（`jobs.ts`の`fallBackRecordingSpeed()`）待機列を抜け、CPUのジョブとして
   `Launch`へ進む。GPUの段を使い切った`Launch`と、クォータ超過などが3回目以降まで続いた`HandleFailure`も同様
   （[`0060`](../../docs/decisions/0060-speedup-fallback-to-native-speed.md)・[`0064`](../../docs/decisions/0064-cpu-slow-motion-and-g6-fallback-on-gpu-shortage.md)）。
3. `sfn/launch.ts`（`waitForTaskToken`パターン、タスクタイムアウト150分・ハートビート
   タイムアウト15分）がワーカーを1台**割り当て**る。割り当て先は自宅ワーカー
   （Issue #49、§3）かEC2 Fleetのどちらかで、EC2の場合は
   `launchRecordingInstance()`（`ec2.ts`）でSpotインスタンスを1台起動し、ジョブを
   `launching` に更新する（自宅ワーカーの場合は**claimと同じ条件付き更新の中で
   デーモンが**`launching`にする。理由は
   [`0034`](../../docs/decisions/0034-launch-handlefailure-timing.md)）。GPUジョブは
   直前に確保したリースのvCPU量で候補インスタンスタイプを絞り
   （`getCandidateInstanceTypes(job, { maxVcpu })`）、実際に確保できたタイプに
   合わせてリースを縮小する。**このハンドラの戻り値はStep Functionsの実行結果に
   影響しない** — 成功/失敗の確定はワーカー自身が`taskToken`経由で
   `SendTaskSuccess`/`SendTaskFailure`を呼ぶことで行う。成功時は
   **`sfn/releaseGpuSlot.ts`**がGPU vCPU容量リースを返却してから完了する。
4. Spot中断・タイムアウト等で失敗すると、3分の待機（インフラ側の`WaitBeforeCheck`。
   理由は`0034`）を挟んで `sfn/handleFailure.ts` が呼ばれる。ジョブが待機中に
   `done` へ遷移していれば何もしない。未完了なら孤児化した可能性のあるインスタンスを
   `terminateInstance()` し（対象は§5参照）、自宅ワーカーへの割り当て・オファーを
   `releaseHomeWorkerAssignment()`（`homeWorker.ts`）で、GPU vCPU容量リースを
   `releaseGpuSlot()`（`gpuSlots.ts`）で解除したうえで、`retryPolicy.ts` の
   `MAX_ATTEMPTS`（**10回**）未満なら`shouldRetry: true`を返してリトライ
   （**`Launch`ではなく`AcquireGpuSlot`へ戻る**——リースを既に返却済みのため）、
   上限に達していればジョブを `failed` に確定する
   （ワーカー自身が既に`failed`を書き込んでいれば上書きしない）。
5. `handleFailure.ts` 自体がAWS APIの一時的な障害で例外を投げても、ジョブが
   非終端状態のまま固まらないよう、インフラ側でリトライ＋最終的な`Fail`遷移が
   用意されている（`infra/README.md`参照）。ただしこの経路はジョブレコード自体を
   直接更新しないため、それでも取りこぼした場合は
   [`0031`](../../docs/decisions/0031-stalled-job-sweep-by-status.md)の定期掃除役が
   拾う（Issue #132）。GPU vCPU容量リースの取りこぼしは
   `handlers/sweepOrphanInstances.ts`のリコンサイラ（§5）が回収する。

## 3. 自宅ワーカーへのジョブ割り当て（`homeWorker.ts` / `workerRouting.ts`, Issue #49）

開発者の自宅サーバーがオンラインで余力があるとき、EC2の代わりにそこで録画させる。
自宅マシンはNAT配下でAWS側から到達できないため**Pull型**にしてある。デーモン本体と
仕様は [`home-worker/README.md`](../../home-worker/README.md)、構築手順は
[`docs/runbooks/home-worker-setup.md`](../../docs/runbooks/home-worker-setup.md) を参照。

> **Pull 型にした理由・オファーと claim の競合をどう決着させるかは
> [`docs/decisions/0018`](../../docs/decisions/0018-home-worker-pull-assignment.md) に
> 集約してある。この節を変更する前に必ず開くこと**（踏み外すと同じリプレイを2台で
> 録画する）。

`Launch` が行うこと:

1. `routingPolicyFor(job)`（`workerRouting.ts`）でこのジョブの方針を決める。
   タイトルごとに「オファーするか」「要求する追加能力」「待機秒数」を変えられる
   （方針の中身と理由は`0018`）。
2. `WorkersTable` のハートビート（`selectHomeWorker()`）を見て、引き受けられる
   ワーカーがいるか判定する。**いなければ何もせず即EC2を起動する**。
3. いれば `offerJobToHomeWorker()` でジョブレコードにオファーを書く。オファーには
   ワーカーコンテナへ渡す環境変数一式（`workerEnv.ts`、taskTokenを含む）を添える
   ので、デーモンはそれをそのまま`docker run`へ渡すだけでよい。オファーは
   sparse GSI `HomeWorkerOfferIndex` に載り、デーモンはこれをポーリングして
   条件付き更新で原子的にclaimする（同じ更新で`workerKind: "home"`・
   `status: "launching"`も確定する）。書き込み自体が条件チェックで失敗した場合の
   扱いは `handleOfferConflict()`（判別根拠は `0018`）。
4. `offerWindowSeconds`（既定20秒、上限`MAX_OFFER_WINDOW_SECONDS`）待って
   claimされなければ `withdrawHomeWorkerOffer()` で**条件付きに**撤回し、EC2へ
   フォールバックする。撤回が条件チェックで失敗した（＝待機中にclaimされた）場合は
   EC2を起動しない。

`assignedWorkerId` が「誰がこのジョブのtaskTokenを持っているか」の唯一の真実で、
**AWS側がこの属性を消すことがclaimの取り消し**になる。消す側は
`sfn/handleFailure.ts` と `admin/stopJob.ts` の2箇所で、後者は取り消しが同期的でない
ことに備えて先に`stopRequestedAt`を立てる（`markJobStopRequested()`。`0018`）。

## 4. EC2 Fleet インスタンスタイプの分散配置（`ec2.ts`, Issue #29）

サブネット（=AZ）×候補インスタンスタイプの全組み合わせを`CreateFleet`へ渡し、
`price-capacity-optimized`で配置する。候補はジョブ（タイトル・録画速度）ごとに違い、
`requiresGpuRecording()`がtrueのジョブはGPU用のLaunch Template・別ECRイメージを使う。
起動手段は順序付きの段（`launchTiersFor()`）で、Spot在庫の枯渇なら次の段・GPUの
フォールバック先リージョン（eu-north-1）へ進む。**候補タイプの一覧・GPU系の別系統・
段とリージョンのフォールバック・コスト推定用の記録は
[`docs/ec2-launch.md`](docs/ec2-launch.md) §1**。

> **候補を足す・変える前に
> [`docs/decisions/0016`](../../docs/decisions/0016-ec2-fleet-instance-type-diversification.md)
> を必ず読むこと**（「同スペック帯だから安全」が繰り返し裏切られている経緯）。

## 5. 孤児インスタンスの検知（`orphanInstances.ts` / `handlers/sweepOrphanInstances.ts`, Issue #23）

ジョブのどの状態遷移とも紐づかないまま課金され続けるEC2インスタンスを、起動直後の記録・
後始末でのタグ検索・10分間隔の定期掃除の3段構えで拾う。定期掃除の**走査の起点はジョブ
レコードではなくAWS上に実在するインスタンス**で、同じLambdaにGPU vCPU容量リースの
リコンサイラが相乗りしている。判定条件と猶予は
[`docs/orphan-sweep.md`](docs/orphan-sweep.md)。

> **判定を緩める・走査の起点を変える前に
> [`docs/decisions/0017`](../../docs/decisions/0017-orphan-sweep-from-aws-instances.md)
> を読むこと**（誤terminateがユーザーの録画をその場で殺す非対称性）。

## 6. ワーカーコンテナの環境変数（`workerEnv.ts`）

ワーカーコンテナ（`worker/entrypoint.py`）へ渡す環境変数は `buildWorkerEnv()` が
一元的に組み立て、**EC2（UserDataの`docker run -e`）と自宅ワーカー（オファーに添えて
`JobRecord.homeWorkerEnv` に書き、デーモンがそのまま`docker run`へ渡す）で共有する**。

倍速録画（`FPS_LIMIT_TARGET_HZ`・`GPU_WORKER`）のような環境差分も、ワーカーの`if`
ではなく起動側がこの関数の出力に足すかどうかで表現する（理由は
[`docs/decisions/0058`](../../docs/decisions/0058-speedup-recording-on-gpu-instances.md)・
[`docs/decisions/0010`](../../docs/decisions/0010-slow-motion-no-worker-side-branching.md)）。

th06ncの1080p録画オプション（Issue #241、`TH06NC_RESOLUTION=1080p`）は
`th10BugfixMarisaB`と同じパターン——`job.options`から直接読む——を使う。th06ncは
自宅ワーカーへ絶対に来ないため「割り当て先に応じて有効/無効が変わる」性質を
持たず、`WorkerEnvOptions`を経由する必要が無い。

`TASK_TOKEN`（Step Functionsの実行を任意に成功/失敗させられるベアラ）を含むため、
ログや外部への出力では必ず `redactWorkerEnv()` を通すこと。**この約束は型で強制して
ある**（`RedactedWorkerEnvironment`。変換口は`toAdminJobRecord()`の1箇所だけで、
`JobRecord`をそのまま返そうとするとコンパイルエラーになる。経緯は
[`docs/decisions/0020`](../../docs/decisions/0020-worker-env-redaction-enforced-by-type.md)）。

## 7. ワーカー起動スクリプト（UserData, `ec2.ts` の `buildUserData()`）

ジョブ固有のUserDataだけを持つLaunch Templateのバージョンを実行時に作ってから
`CreateFleet`する。ECSエージェントの停止・`trap 'shutdown -h now' EXIT`・起動前段階の
失敗の即時通知は**いずれも事故を経て入れた対策で、消すと再発する**
（[`docs/decisions/0019`](../../docs/decisions/0019-userdata-ecs-agent-off-and-bootstrap-failure-notification.md)）。
スクリプトの中身と値のエスケープは [`docs/ec2-launch.md`](docs/ec2-launch.md) §2。

## 8. マジックリンク送信・レート制限（`requestMagicLink.ts`, `rateLimit.ts`）

- 同一メール（`+`エイリアス正規化後、`normalizeEmailForRateLimit()`）は24時間5件まで
  （`RATE_LIMIT_MAX_REQUESTS_PER_DAY`）。判定と記録を`EmailRateLimitTable`への条件付き
  `UpdateCommand`1回に一本化して原子的に行う（競合状態を避けるため）。固定ウィンドウ
  方式（「そのメールで最初にカウントされた時刻から24時間」）で、厳密なスライディング
  ウィンドウではない。
- ジョブは`status: "pending"`で作成されるが、Step Functionsはまだ起動しない
  （`POST /jobs/{jobId}/start`で初めて起動）。メール送信自体が失敗した場合は
  作成したジョブを削除してロールバックする。
- `pending`ジョブの受付期限は24時間（`jobs.ts`の`PENDING_JOB_TTL_MS`。bot/濫用対策で、
  アップロード用S3の保持期間とは独立）。
- `replayKey`はサーバー採番の形式（`uploads.ts`の`REPLAY_KEY_PATTERN`、
  `replays/<uuid>.rpy`）と一致しない値を400で拒否する（Issue #127 SEC-1）。
- `RequestMagicLinkRequest`に`game`/`estimatedDurationSeconds`/`replayInfo`は
  **含まない**。`JobRecord`のこれら3項目はすべて`replayKey`が指すアップロード済み
  .rpyをサーバー側で取得・再パースした結果だけから決まる——`replay.ts`の
  `fetchReplayBytes()`（`POST /replays/parse`（`parseReplay.ts`）と共通処理）で
  取得し、`parseReplayInfo()`で解析する。再パースに失敗した場合（形式不明の破損
  ファイル等）のみ`game`はth07を既定とし、`estimatedDurationSeconds`は`null`
  （進捗率非表示）として録画自体は継続する（`decisions/0021`と同じ割り切り）。
  `parseReplayInfo()`は「形式不明」と「形式は読めるが録画未対応」をどちらも
  `ok:false`にまとめるため、後者は`result.error.game`から検出タイトルを別途拾う。
  クライアント申告値をやめた理由は
  [`docs/decisions/0032`](../../docs/decisions/0032-replay-info-server-side-reparse-only.md)。

> 濫用対策をここから増やす前に
> [`docs/decisions/0007`](../../docs/decisions/0007-no-ip-rate-limit-no-recaptcha.md) を読むこと
> —— IP 単位のレート制限・reCAPTCHA は実装漏れではなく、意図的に見送っている。

### メール本文（`ses.ts`）

マジックリンクメール・完了メールの文面組み立て（言語別の出し分け・リンクの組み立て・
ダウンロード期限のタイムゾーン表記・フィールドのサニタイズ）は
[`docs/email-templates.md`](docs/email-templates.md) に分けてある。

## 9. キルスイッチ・月間コストガード（`settings.ts`, `costGuard.ts`, Issue #14／#130）

`requestMagicLink.ts`はメールレート制限より前に、キルスイッチ（`acceptingNewJobs`）と
月間コストガード（`monthlyCostLimitUsd`）の2つのグローバルな受付制御を確認する
（`SettingsTable`の`AdminSettings`）。該当すれば`POST /magic-links`は503を返す。
`startJob.ts`ではキルスイッチのみ確認する。エンドポイントごとのチェック内容・
キャッシュ・非対称な扱いの理由は
[`docs/admission-control.md`](docs/admission-control.md) に分けてある。

## 10. ダウンロードURLとContent-Disposition（`getJob.ts`）

動画ダウンロードはブラウザ標準のダウンロード機構（進捗表示・タブを離れても継続・
ディスクへの直接ストリーミング）に任せる設計。S3のGetObject APIは
`response-content-disposition`クエリパラメータの値をそのまま`Content-Disposition`
レスポンスヘッダーへエコーバックする仕様を持つため、`getJob.ts`の`buildDownloadUrl()`
がこのクエリ（値の組み立ては`packages/shared/src/download.ts`）を含めて
`downloadUrl`/`downloadUrl720p`を返すだけで、フロントエンド側は単純な
`<a href={...} download>`でよく、fetch+Blob化もCORS許可も不要になる。CloudFront側は
このクエリをオリジンへ転送しキャッシュキーにも含める専用の`CachePolicy`を使う
（異なる解像度のファイル名でキャッシュが混線しないため。`infra/README.md`参照）。

## 11. 管理API（`/admin/*`、Issue #51）

運用調査用の管理画面（`apps/web/src/admin/`）向けAPI群。**利用者向けの本流フローとは
完全に独立しているため、エンドポイント一覧・認証方式・触る前提は
[`docs/admin-api.md`](docs/admin-api.md) に分けてある**。フロント側は
[`apps/web/docs/admin-ui.md`](../web/docs/admin-ui.md)。

## 12. 環境変数（`config.ts`）

すべて `infra/lib/sattori-stack.ts` の `commonEnv` から注入され、`loadConfig()`が必須
環境変数の存在を検証する。**`STATE_MACHINE_ARN`は循環依存を避けるため`commonEnv`に含めず**、
必要なLambdaだけが個別に受け取る。個別指定の一覧・GPUフォールバック先（`GPU_FALLBACK_*`）・
`SES_CONFIGURATION_SET`は [`docs/environment-variables.md`](docs/environment-variables.md)。

## 13. 計測（アナリティクス、`POST /beacon`、Issue #142・#144）

Cookie/localStorageを一切使わないサーバーサイド計測。`recordAnalyticsEvent.ts`が
`AnalyticsEventInput`（`@sattori/shared`。pageview/parse_errorの2種類）を受け、
生IP・生User-Agentを含まない形へ正規化してから`AnalyticsEventsTable`（DynamoDB、
PK=eventDate/SK=eventId、TTL 180日）へ書き込む。国の取得・User-Agent正規化・
訪問者ハッシュ化・集計の参照仕様は[`docs/analytics.md`](docs/analytics.md)に分けてある。

## 14. テスト

各ハンドラに対応する `*.test.ts` が同ディレクトリにある（vitest、AWS SDKクライアントは
モック）。`pnpm --filter @sattori/api test` で実行。`JobRecord`のテスト用オブジェクトは
`testSupport/jobRecord.ts`の`createJobRecord(overrides?)`で作る（Issue #188）。属性を追加する
たびに各テストファイルの全項目リテラルを書き換えずに済むよう、デフォルト値はここへ一本化してあり、
テストごとに異なる属性だけを引数で上書きする。
