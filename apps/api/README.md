# apps/api

Lambda ハンドラ群（AWS API Gateway HTTP API 経由）。S3署名URL発行・リプレイ解析・
マジックリンク送信・ジョブ起動・状態取得・完了メール送信・Step Functions連携を担う。
API契約自体は `packages/shared/README.md` を参照。**ここには「今どうなっているか」だけを
書く** —— なぜそうしたかの根拠は [`docs/decisions/`](../../docs/decisions/README.md)、
管理API（`/admin/*`）の詳細は [`docs/admin-api.md`](docs/admin-api.md) にある。

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
| `requestMagicLink.ts` | `POST /magic-links` | レート制限チェック→`status: "pending"`の`JobRecord`作成→SESでマジックリンク送信。メール送信自体が失敗したらジョブを削除してロールバックする。低速録画（Issue #68）の要求は**低速録画に対応したタイトル（`supportsSlowMotion()`、Issue #101）でなければ握り潰す**（等倍で録画できる以上エラーにはしない） |
| `startJob.ts` | `POST /jobs/{jobId}/start` | `pending`→`queued`への原子遷移＋Step Functions `StartExecution` |
| `getJob.ts` | `GET /jobs/{jobId}` | ジョブ状態取得。完了時はCloudFrontのダウンロードURL・プレビュー再生URLを組み立てる。低速録画（Issue #68）で走るかどうか（`isSlowMotionRecording()`）も返す |
| `getWorkerAvailability.ts` | `GET /worker-availability` | 常駐ワーカー（自宅ワーカー、Issue #49）の空き状況。ページAが「低速録画」を選べるか判定するためだけの公開エンドポイント。**認証なしで公開されるため`workerId`・台数・負荷は返さない**（開発者の自宅環境の稼働状況を必要以上に外へ出さない） |
| `sendCompletionEmail.ts` | JobsTableのDynamoDB Streams | ジョブが`done`に遷移した瞬間を検知しSESで完了メール送信 |
| `sweepOrphanInstances.ts` | EventBridgeのスケジュールルール（10分間隔） | 孤児化した録画EC2インスタンスの定期掃除（Issue #23。§5） |
| `sfn/launch.ts` | Step Functions `Launch`タスク | EC2 Fleetでワーカーを1台起動（`waitForTaskToken`。成否確定はワーカー自身が行う） |
| `sfn/handleFailure.ts` | Step Functions `HandleFailure`タスク | 孤児インスタンスをterminateしつつリトライ可否を判定 |
| `admin/authorizer.ts` | `/admin/*` の Lambda Authorizer | 共有トークンの検証（[`docs/admin-api.md`](docs/admin-api.md)） |
| `admin/listJobs.ts` | `GET /admin/jobs` | ジョブ一覧（新しい順・status絞り込み・カーソルページング） |
| `admin/getJobDetail.ts` | `GET /admin/jobs/{jobId}` | `JobRecord`全フィールド＋ダウンロード導線 |
| `admin/getExecution.ts` | `GET /admin/jobs/{jobId}/execution` | Step Functions実行の状態・履歴 |
| `admin/getLogs.ts` | `GET /admin/jobs/{jobId}/logs` | ワーカーコンテナのCloudWatch Logs（見つからない場合はEC2コンソール出力にフォールバック） |
| `admin/stopJob.ts` | `POST /admin/jobs/{jobId}/stop` | 暴走ジョブの緊急停止（実行停止→インスタンス終了→`failed`確定） |
| `admin/retryJob.ts` | `POST /admin/jobs/{jobId}/retry` | 失敗ジョブの再実行（**新しいjobId**へ複製して起動） |
| `admin/getCosts.ts` | `GET /admin/costs` | コスト推定の日次/週次/月次集計（全件Scan + アプリ側集計） |
| `admin/getSettings.ts` | `GET /admin/settings` | キルスイッチ・月間コストガード閾値の現在値と当月推定コストを取得（Issue #14） |
| `admin/updateSettings.ts` | `POST /admin/settings` | キルスイッチ・月間コストガード閾値の更新（Issue #14） |
| `recordAnalyticsEvent.ts` | `POST /beacon` | Cookie無しの計測ビーコンの受け口。pageview/parse_errorイベントを`AnalyticsEventsTable`へ記録する（Issue #142。§13） |

## 2. ジョブ起動〜Step Functionsの流れ

1. `startJob.ts` が `pending`→`queued` への遷移をDynamoDBの条件付き更新で原子的に
   行い（`jobs.ts` の `startPendingJob()`、`ConditionExpression: "#s = :pending"`）、
   Step Functions の実行を開始する（`attempt: INITIAL_ATTEMPT`、`retryPolicy.ts`）。
   条件不成立（既に起動済み）なら `JobAlreadyStartedError` を捕まえて現在の状態を
   冪等に返すだけで、Step Functionsは再起動しない。
2. `sfn/launch.ts`（`waitForTaskToken`パターン、タスクタイムアウト150分・ハートビート
   タイムアウト15分）がワーカーを1台**割り当て**る。割り当て先は自宅ワーカー
   （Issue #49、§3）かEC2 Fleetのどちらかで、EC2の場合は
   `launchRecordingInstance()`（`ec2.ts`）でSpotインスタンスを1台起動し、ジョブを
   `launching` に更新する（自宅ワーカーの場合は**claimと同じ条件付き更新の中で
   デーモンが**`launching`にする。後から書くと、先に走り出したコンテナの`recording`を
   上書きしうるため）。
   **このハンドラの戻り値はStep Functionsの実行結果に影響しない** — 成功/失敗の確定は
   ワーカー自身が`taskToken`経由で`SendTaskSuccess`/`SendTaskFailure`を呼ぶことで行う。
3. Spot中断・タイムアウト等で失敗すると、3分の待機（インフラ側の`WaitBeforeCheck`。
   Spot中断の早期失敗通知はワーカーの処理継続中に送られるため、即座に判定せず
   猶予を置く）を挟んで `sfn/handleFailure.ts` が呼ばれる。ジョブが待機中に
   `done` へ遷移していれば何もしない。未完了なら孤児化した可能性のあるインスタンスを
   `terminateInstance()` し（対象は`JobRecord.instanceId`と**タグ`sattori:jobId`から
   引いたインスタンスの和集合**。§5）、
   自宅ワーカーへの割り当て・オファーを
   `releaseHomeWorkerAssignment()`（`homeWorker.ts`）で解除したうえで、
   `retryPolicy.ts` の `MAX_ATTEMPTS`（**10回**）未満なら
   `shouldRetry: true` を返してリトライ、上限に達していればジョブを `failed` に確定する
   （ワーカー自身が既に`failed`を書き込んでいれば上書きしない）。
4. `handleFailure.ts` 自体がAWS APIの一時的な障害で例外を投げても、ジョブが
   非終端状態のまま固まらないよう、インフラ側でリトライ＋最終的な`Fail`遷移が
   用意されている（`infra/README.md`参照）。

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
   （**th20だけ待機を上限まで伸ばす**・**低速録画の能力要求はタイトルではなく
   `job.options.slowMotion` に紐づく**。理由は `0018`）。
2. `WorkersTable` のハートビート（`selectHomeWorker()`）を見て、引き受けられる
   ワーカーがいるか判定する。**いなければ何もせず即EC2を起動する**ので、自宅が
   落ちている平常時に録画開始が遅れることはない。
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

単一インスタンスタイプのみだとそのハードウェアプールが時間帯によって枯渇し
`InsufficientInstanceCapacity` で起動自体が失敗するため、サブネット（=AZ）×候補
インスタンスタイプの全組み合わせを `CreateFleet` の `Overrides` に渡し、
`AllocationStrategy: "price-capacity-optimized"`（`SingleInstanceType: false`）で
配置する。候補はタイトルごとに違う。

| 対象 | 定数（`ec2.ts`） | 候補インスタンスタイプ |
| --- | --- | --- |
| th06/07/08 | `DEFAULT_CANDIDATE_INSTANCE_TYPES` | `c7i.xlarge` / `c7a.xlarge` / `c7i-flex.xlarge` / `m7i.xlarge` |
| th11 | `TH11_CANDIDATE_INSTANCE_TYPES` | `c7i.2xlarge` / `c7a.2xlarge` / `m7i.2xlarge` |
| th20 | `TH20_CANDIDATE_INSTANCE_TYPES` | `c7i.4xlarge` のみ |

> **候補を足す・変える前に
> [`docs/decisions/0016`](../../docs/decisions/0016-ec2-fleet-instance-type-diversification.md)
> を必ず読むこと**（各候補の実機検証の裏付け・th20が1タイプしかない理由・
> 「同スペック帯だから安全」が繰り返し裏切られている経緯）。インスタンスの起動を
> CDK側へ移さない理由は [`0002`](../../docs/decisions/0002-ec2-launch-at-runtime-not-iac.md)。

`CreateFleet`が実際に確保したインスタンスタイプ・AZは `result.Instances[0]` から
そのまま取得でき、追加の`DescribeInstances`呼び出しは不要。`JobRecord.instanceType`/
`.availabilityZone`として記録する（`jobs.ts`の`updateJobInstance()`）。これは録画品質の
分析・運用調査用の内部データで、ユーザー向けAPI（`GetJobResponse`）には含めない。

コスト推定（Issue #60）用に、**Spot単価だけは`CreateFleet`のレスポンスに含まれない**ため
`fetchSpotPrice()`が`DescribeSpotPriceHistory`を1回だけ引いて
`JobRecord.spotPricePerHour`へ記録し、`sfn/launch.ts`が`markJobLaunched()`で
`JobRecord.launchedAt`（課金起点）を記録する。**単価の取得に失敗しても録画ジョブは
落とさない**（nullへ縮退）、**`launchedAt`は既に値があれば書き換えない**（条件付き更新）。
理由は
[`docs/decisions/0021`](../../docs/decisions/0021-cost-estimation-side-data-never-fails-the-job.md)。

## 5. 孤児インスタンスの検知（`orphanInstances.ts` / `handlers/sweepOrphanInstances.ts`, Issue #23）

**孤児 = ジョブのどの状態遷移とも紐づかないまま課金され続けるEC2インスタンス。**
対策は3段構えで、後段ほど「前段のハンドラ自体が失敗した場合」を拾う。

1. **窓を狭める**: `launch.ts` は `CreateFleet` の直後に `updateJobInstance()` を
   呼ぶ（`updateJobStatus`/`updateJobWorkerKind`より先）。
2. **後始末でタグからも引く**: `sfn/handleFailure.ts`・`admin/stopJob.ts` は
   `JobRecord.instanceId` だけでなく `findJobInstanceIds()`（タグ`sattori:jobId`での
   `DescribeInstances`）の結果も terminate する。
3. **定期掃除**: `handlers/sweepOrphanInstances.ts` がEventBridgeのスケジュール
   （`ORPHAN_SWEEP_INTERVAL_MINUTES` = 10分間隔）で走る。**走査の起点はジョブ
   レコードではなくAWS上に実在するインスタンス**（`listTaggedInstances()`）。

判定は `orphanInstances.ts` にあり、猶予15分（`ORPHAN_INSTANCE_GRACE_MINUTES`）・
Step Functions実行の生死（`getExecutionLiveness()`）・実行中ジョブでは最新1台を保護、
と徹底して安全側に倒してある。最悪の孤児寿命は「猶予15分 + 掃除間隔10分」＝25分。

> **判定を緩める・走査の起点を変える前に
> [`docs/decisions/0017`](../../docs/decisions/0017-orphan-sweep-from-aws-instances.md)
> を読むこと**（各条件の根拠と、誤terminateがユーザーの録画をその場で殺す非対称性）。

## 6. ワーカーコンテナの環境変数（`workerEnv.ts`）

ワーカーコンテナ（`worker/entrypoint.py`）へ渡す環境変数は `buildWorkerEnv()` が
一元的に組み立て、**EC2（UserDataの`docker run -e`）と自宅ワーカー（オファーに添えて
`JobRecord.homeWorkerEnv` に書き、デーモンがそのまま`docker run`へ渡す）で共有する**。

こうしておくとワーカー側は「自分がどこで動いているか」を一切知らずに済み、環境差分は
すべてこの関数の出力の違いとして表現される。低速録画（Issue #68。自宅ワーカーでのみ
行う）のような分岐も、ワーカーの`if`ではなく「起動側が録画速度の環境変数を足すか
どうか」で表現すること（[`docs/decisions/0010`](../../docs/decisions/0010-slow-motion-no-worker-side-branching.md)）。

`TASK_TOKEN`（Step Functionsの実行を任意に成功/失敗させられるベアラ）を含むため、
ログや外部への出力では必ず `redactWorkerEnv()` を通すこと。**この約束は型で強制して
ある**（`RedactedWorkerEnvironment`。変換口は`toAdminJobRecord()`の1箇所だけで、
`JobRecord`をそのまま返そうとするとコンパイルエラーになる。経緯は
[`docs/decisions/0020`](../../docs/decisions/0020-worker-env-redaction-enforced-by-type.md)）。

## 7. ワーカー起動スクリプト（UserData, `ec2.ts` の `buildUserData()`）

ベースの Launch Template（AMI/IAM/SGはCDK側で固定）に対し、ジョブ固有のUserDataのみを
持つ新しいバージョンを`CreateLaunchTemplateVersion`で作成してから`CreateFleet`する。
UserDataスクリプトがやること:

- `systemctl disable --now ecs`（ECS最適化AMIをプレーンなdockerホストとして使う）
- `trap 'shutdown -h now' EXIT`（どこで失敗しても必ずインスタンスを終了させる）
- ECRログイン → pull → `docker run`（`--log-opt awslogs-stream=${jobId}`）
- コンテナ起動前段階で失敗したら`aws stepfunctions send-task-failure`で即時通知

> **この3点はいずれも事故を経て入れた対策で、消すと再発する**。理由は
> [`docs/decisions/0019`](../../docs/decisions/0019-userdata-ecs-agent-off-and-bootstrap-failure-notification.md)。

`-e KEY=VALUE`として埋め込む環境変数の値（`taskToken`含む）はすべて`shellEscape()`で
単一引用符に括ってからスクリプトへ差し込む。`replayKey`等の入口検証（§8）をすり抜けた
値やDB内の既存汚染データが来ても、コマンドインジェクションへ変換されないための
多層防御（Issue #127 SEC-1）。

## 8. マジックリンク送信・レート制限（`requestMagicLink.ts`, `rateLimit.ts`）

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
- `replayKey`はサーバー採番の形式（`uploads.ts`の`REPLAY_KEY_PATTERN`、
  `replays/<uuid>.rpy`）と一致しない値を400で拒否する。`estimatedDurationSeconds`も
  有限の正数以外は400（Issue #127 SEC-1。どちらもワーカーEC2の起動スクリプトへ
  そのまま渡る値のため、入口で形式を固定する）。
- `JobRecord.replayInfo`は**クライアントが送ったJSONをそのまま転記しない**。
  `replayKey`が指すアップロード済み.rpyを`POST /replays/parse`（`parseReplay.ts`）
  と共通の`replay.ts`の`fetchReplayBytes()`で再取得し、サーバー側で
  `parseReplayInfo()`により再パースする（Issue #133 OPS-1）。かつては
  `body.replayInfo`を転記しており、それが完了メール本文へそのまま載ることを
  利用して第三者宛にフィッシング文面を仕込める経路になっていた。取得・解析に
  失敗しても`replayInfo`を`null`として録画自体は継続する（`decisions/0021`と
  同じ割り切り）。

> 濫用対策をここから増やす前に
> [`docs/decisions/0007`](../../docs/decisions/0007-no-ip-rate-limit-no-recaptcha.md) を読むこと
> —— IP 単位のレート制限・reCAPTCHA は実装漏れではなく、意図的に見送っている。

### メール本文（`ses.ts`）

マジックリンクメール・完了メールの2通とも、文面はジョブ作成時に選ばれた言語
（`JobRecord.language`）で出し分ける。本文の構成はどちらも共通で、冒頭に**どのリプレイに
ついてのメールかを示すブロック**（作品タイトル・プレイヤー名・難易度・自機タイプ・スコア。
`JobRecord.replayInfo` 由来で、値が取れない項目と `replayInfo` 自体が無いジョブでは
その行／ブロックごと省く）を置き、続けてジョブページへのリンクを案内する（Issue #95）。

- リンクは常に**ジョブページ**（`/jobs/{jobId}`、`en`なら`/en/jobs/{jobId}`）で、
  動画の直リンクは載せない（ダウンロードURLはジョブの状態次第で変わり得るため）。
- 完了メールのダウンロード期限（`calculateDownloadExpiresAt()`）は、**日本語の文面はJST、
  英語の文面はUTC**で表記する（メールでは閲覧者のタイムゾーンが分からないため、
  タイムゾーン名まで必ず併記する）。
- 作品タイトルは `GAME_TITLES`（日本語名。副題に英語名を含む）を両言語で使い、自機タイプは
  言語に応じたローカライズ名（`localizedCharacterName()`）を使う。

## 9. キルスイッチ・月間コストガード（`settings.ts`, `costGuard.ts`, Issue #14／#130）

`requestMagicLink.ts`は上記のメールレート制限より前に、以下2つのグローバルな
受付制御を順に行う。どちらも`SettingsTable`（PK固定値1件のシングルトン設定、
`SETTINGS_KEY = "global"`）に持つ`AdminSettings`を参照する。

- **キルスイッチ**（`acceptingNewJobs`）: 管理画面（`/admin/settings`）から手動で
  新規録画の受付を即座に停止できる。月間コストガードが発動する前に運用者が
  緊急停止する用途を想定している。`getSettings()`はキャッシュせず毎回GetItem
  するため（1件のみの軽量な読み取り）、切替は次のリクエストから反映される。
- **月間コストガード**（`monthlyCostLimitUsd`、既定`DEFAULT_MONTHLY_COST_LIMIT_USD`
  ＝50 USD）: 月間の録画**回数**ではなく、推定コスト機能
  （`@sattori/shared`の`estimateJobCost()`、Issue #60）による**当月の推定コスト合計**
  が閾値に達したら新規受付を止める。当月コストの算出
  （`adminCosts.ts`の`estimateCurrentMonthCostUsd()`）は`JobsTable`の全件Scanを要する
  ため、ユーザー向け経路専用の`costGuard.ts`が5分（`COST_GUARD_CACHE_TTL_MS`）
  Lambda実行コンテキストにキャッシュする（＝閾値到達直後の数分は数件超過して受け付ける）。
  金額で判定する理由とこの割り切りの根拠は
  [`docs/decisions/0022`](../../docs/decisions/0022-cost-guard-by-estimated-amount-not-job-count.md)。
- どちらも該当すれば`POST /magic-links`は503（`service_paused` /
  `monthly_cost_limit_reached`）を返す。エラーメッセージはそのままフロントエンドに
  表示される（`apps/web`はAPIの`ApiError.message`をそのままユーザーに見せる設計）。
- **キルスイッチは`startJob.ts`（`POST /jobs/{jobId}/start`）でも確認する**（Issue #130、
  `REL-1`）。マジックリンク発行後は`pending`ジョブが最大24時間有効なため、
  `requestMagicLink.ts`側の受付停止だけでは、既に発行済みのリンクを開かれると
  録画が始まってしまう。`startJobFn`が`pending`→`queued`の原子遷移
  （`startPendingJob()`）を行う**前**に`getSettings()`を確認し、停止中なら
  ジョブを`pending`のまま据え置いて503（`service_paused`）を返す——起動済み
  （`pending`以外）へのアクセスは冪等応答なのでこのチェックを通らず、受付再開後は
  同じリンクで起動できるため、ユーザー側の損失はゼロ。**月間コストガードは
  `startJob.ts`では見ていない**——`getCachedMonthlyCostUsd()`はJobsTableの全件Scanを
  要し、かつ録画リクエストが一度成功した（メールが届いた）にもかかわらず起動できない
  というユーザー体験の悪化を避けるため、意図的にキルスイッチのみとしている。
- 設定の更新（`POST /admin/settings`）は`settings.ts`の`updateSettings()`が単純な
  読み取り→マージ→上書きで行う。管理者は1人固定で更新頻度も低いため、
  `rateLimit.ts`のような原子的な条件付き更新は採用していない。

## 10. ダウンロードURLとContent-Disposition（`getJob.ts`）

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

## 11. 管理API（`/admin/*`、Issue #51）

運用調査用の管理画面（`apps/web/src/admin/`）向けのAPI群。ジョブ一覧・詳細・
ダウンロード導線・Step Functions実行の閲覧・ワーカーログ・緊急停止・再実行・
コスト集計・設定更新を提供する。認証はSSM Parameter Storeに置いた共有トークンを
Lambda Authorizerで検証する方式で、ユーザー向けの認可（jobId自体が秘密値）とは別系統
（[`docs/decisions/0005`](../../docs/decisions/0005-admin-auth-ssm-shared-token.md)）。
**利用者向けの本流フローとは完全に独立しているため、詳細は
[`docs/admin-api.md`](docs/admin-api.md) に分けてある**（一覧のページング・停止/再実行の
順序・ログ取得のフォールバックなど、触るなら必読の前提がそこにある）。フロント側は
[`apps/web/docs/admin-ui.md`](../web/docs/admin-ui.md)。

## 12. 環境変数（`config.ts`）

すべて `infra/lib/sattori-stack.ts` の `commonEnv`（+ `startJob.ts`/
`admin/getExecution.ts`/`admin/stopJob.ts`/`admin/retryJob.ts`/
`sweepOrphanInstances.ts`専用の`STATE_MACHINE_ARN`、`admin/authorizer.ts`専用の
`ADMIN_TOKEN_PARAMETER_NAME`、`admin/getLogs.ts`専用の`WORKER_LOG_GROUP`単独指定、
`sweepOrphanInstances.ts`専用の`JOBS_TABLE`単独指定）
から注入される。`loadConfig()`が必須環境変数の存在を
検証する（管理API用Lambdaは`commonEnv`を使わず個別の環境変数のみを持つ）。

`SES_CONFIGURATION_SET`は`SattoriEdgeStack`が作った`ses.ConfigurationSet`名
（`crossRegionReferences`経由）。`ses.ts`が`SendEmailCommand`へ指定し、
バウンス・苦情・拒否イベントを運用アラート用SNSへ流す（Issue #133 OPS-1、
[`docs/decisions/0025`](../../docs/decisions/0025-ops-alerts-per-region-sns-topics.md)）。

`STATE_MACHINE_ARN`が`commonEnv`に含まれない理由: ステートマシンは`launchFn`/
`handleFailureFn`（Lambda ARN）を呼び出すため、これらのLambdaの環境変数がステート
マシンARNを参照するとCloudFormationの循環依存になる。`StartExecution`/`DescribeExecution`
系を呼ぶ`startJob.ts`・`admin/getExecution.ts`・`admin/stopJob.ts`・`admin/retryJob.ts`・
`sweepOrphanInstances.ts`だけが個別の環境変数として受け取る（いずれもステートマシンから
呼ばれる側ではないため循環しない）。

## 13. 計測（アナリティクス、`POST /beacon`、Issue #142）

Cookie/localStorageを一切使わないサーバーサイド計測。フロントエンドから送られる
`AnalyticsEventInput`（`@sattori/shared`。pageview/parse_errorの2種類）を受け、
`analytics.ts`の`recordAnalyticsEvent()`が生IP・生User-Agentを含まない形へ正規化
してから`AnalyticsEventsTable`（DynamoDB、PK=eventDate/SK=eventId、TTL 180日）へ
書き込む。

- `CloudFront-Viewer-Country`ヘッダーから国を得るが、これはWebCdn(CloudFront)の
  `/beacon`ビヘイビア経由のリクエストにしか付与されない（他のエンドポイントと違い、
  このパスだけCloudFrontを前段に置いている。`infra/README.md`参照）。ヘッダーが
  無い（＝直接HTTP APIを叩かれた）場合も`country: null`で記録するだけで、リクエスト
  自体は失敗させない。
- User-Agentは`userAgent.ts`の`classifyUserAgent()`でブラウザ/OSの粗いカテゴリへ
  正規化する（バージョンは保持しない）。ビューポート幅・`document.referrer`の丸め方
  はフロントエンド側（`apps/web/README.md`）と合わせて
  [`docs/decisions/0024`](../../docs/decisions/0024-cookieless-analytics-beacon.md)
  にまとめてある。
- **`RecordAnalyticsEventFn`は`commonEnv`を使わない**（`loadAnalyticsConfig()`が
  `ANALYTICS_EVENTS_TABLE`のみを読む）。管理系Lambdaと同じ理由で、計測用テーブルの
  読み書きしか行わないため（§12）。
- 計測の失敗（DynamoDB書き込みエラー等）はユーザー体験に影響させないため、常に
  202を返す（呼び出し側は`navigator.sendBeacon`でレスポンスを見ない）。

> **収集する情報を増やす・訪問者を横断して繋げる識別子を持たせる等の変更は、
> 必ず[`docs/decisions/0024`](../../docs/decisions/0024-cookieless-analytics-beacon.md)
> の「あえて集めないもの」を確認してから行うこと。**

## 14. テスト

各ハンドラに対応する `*.test.ts` が同ディレクトリにある（vitest、AWS SDKクライアントは
モック）。`pnpm --filter @sattori/api test` で実行。
