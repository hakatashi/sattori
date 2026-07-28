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

## 環境変数（`config.ts`）

すべて `infra/lib/sattori-stack.ts` の `commonEnv`（+ `startJob.ts`専用の
`STATE_MACHINE_ARN`）から注入される。`loadConfig()`が必須環境変数の存在を検証する。

`STATE_MACHINE_ARN`が`commonEnv`に含まれない理由: ステートマシンは`launchFn`/
`handleFailureFn`（Lambda ARN）を呼び出すため、これらのLambdaの環境変数がステート
マシンARNを参照するとCloudFormationの循環依存になる。`StartExecution`を呼ぶ
`startJob.ts`だけが個別の環境変数として受け取る。

## テスト

各ハンドラに対応する `*.test.ts` が同ディレクトリにある（vitest、AWS SDKクライアントは
モック）。`pnpm --filter @sattori/api test` で実行。
