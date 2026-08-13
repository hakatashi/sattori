# home-worker — 自宅サーバー録画ワーカー（Issue #49）

開発者の自宅サーバーがオンラインかつCPUに余裕があるとき、AWS の EC2 Fleet の代わりに
録画ジョブを引き受ける常駐デーモン。EC2 Spot がコストの7割超を占める（`docs/research/aws-region-cost-analysis.md`）
ため、自宅で処理できたぶんはそのまま丸ごと削減になる。

**録画そのものは EC2 とまったく同じ ECR イメージ（`worker/`）で行う**。このディレクトリに
あるのは「ジョブを取りに行き、コンテナを起動し、ログを転送し、後始末をする」だけの
薄い常駐プロセスであり、録画パイプラインのロジックは一切持たない。

そのため実装は**録画ワーカー（`worker/`、Python）ではなくモノレポ側の TypeScript**
（pnpm workspace の `@sattori/home-worker`）である。AWS 側と噛み合う型・定数
（`SUPPORTED_GAME_IDS` / `WorkerHeartbeat` / `WORKER_HEARTBEAT_*` /
`HOME_WORKER_OFFER_INDEX` など）を `@sattori/shared` から直接 import する。

> 「録画ワーカーだけ Python」という例外がここに及ばない理由は
> [`docs/decisions/0003`](../docs/decisions/0003-worker-python-home-worker-typescript.md) 参照。

## 1. なぜ Pull 型なのか

自宅マシンは動的グローバルIP・NAT配下にあり、AWS 側から到達できないため、
**自宅がジョブを取りに行く Pull 型**にしてある（Issue #49 の論点1）。録画ジョブは
Step Functions の `Launch` ステート（`waitForTaskToken`）が「taskToken を持つ主体が
結果を返せば成立する」設計になっているので、EC2 ワーカーと自宅ワーカーはまったく同じ
インターフェースで扱える。ステートマシン本体・リトライロジック
（`apps/api/src/retryPolicy.ts`）は自宅ワーカーの存在を知らない。

> **Pull 型を選んだ根拠と採らなかった選択肢、オファーと claim の競合をどう決着させるかは
> [`docs/decisions/0018`](../docs/decisions/0018-home-worker-pull-assignment.md) に集約して
> ある**（AWS 側の記述と重複させないため、根拠はあちらの1箇所だけに置く）。

## 2. ジョブが自宅へ流れるまで

```
[Launch Lambda(apps/api/src/handlers/sfn/launch.ts)]
  ① WorkersTable のハートビートを読む
     └ 新鮮なハートビートが無い / 空きが無い / 対応外タイトル → 即 EC2 Fleet 起動（遅延ゼロ）
  ② オファーを書く: JobsTable に homeWorkerOfferState="open" + 期限 + homeWorkerEnv
     （homeWorkerEnv = ワーカーコンテナへ渡す環境変数一式。taskToken を含む）
  ③ 最大 offerWindowSeconds（既定20秒）claim を待つ
        ▼
[自宅デーモン(このディレクトリ)]
  ④ sparse GSI `HomeWorkerOfferIndex` をポーリング（既定3秒間隔）
  ⑤ 条件付き UpdateItem で原子的に claim
     （assignedWorkerId = 自分, workerKind = "home", status = "launching" を1回で確定）
  ⑥ docker run（EC2 と同じイメージ・同じ環境変数 + 一時AWS認証情報）
  ⑦ コンテナ出力を CloudWatch Logs `/sattori/worker` のストリーム `{jobId}` へ転送
        ▼
[ワーカーコンテナ(worker/entrypoint.py)]
  ⑧ S3からリプレイ取得 → 録画 → S3へ結果アップロード → DynamoDB更新
     → taskToken で SendTaskSuccess/Failure（EC2 と完全に同一）
```

③ で時間内に claim されなければ、Lambda はオファーを**条件付きで**撤回してから
EC2 Fleet を起動する。撤回が条件チェックで失敗した（＝待機中に claim された）場合は
EC2 を起動しない。ここを踏み外すと同じリプレイを2台で録画してしまう。

## 3. claim の取り消し（＝孤児 claim の後始末）

`assignedWorkerId` が「誰がこのジョブの taskToken を持っているか」の唯一の真実である。
**AWS 側がこの属性を消すことが claim の取り消し**を意味する。消す側は2箇所:

- `HandleFailure`（`apps/api/src/handlers/sfn/handleFailure.ts`）— EC2 に対する
  `TerminateInstances` と同じ位置づけの後始末。
- 管理画面からの緊急停止（`POST /admin/jobs/{jobId}/stop`、Issue #59）。

NAT 配下のデーモンには通知が届かないため、**取り消しの捕捉はデーモン側の能動的な
確認だけが手段**になる。取りこぼすと、既に別経路でリトライが始まっているジョブを
二重に録画する（同じ S3 キー・同じジョブレコードを2つのワーカーが書く）ので、
次の3点で捕捉している:

1. 実行中は `CLAIM_CHECK_INTERVAL_SEC`（30秒）ごとに `touchClaim` で確認する。
   **コンテナを起動する前から**回すので、イメージの pull 中に取り消された場合は
   コンテナを起動せずに終わる。
2. **実行中のジョブと同じ jobId がオファーに再出現したら、その場で確認する**。
   オファーは `attribute_not_exists(assignedWorkerId)` を条件に書かれるので、
   再出現は取り消しの強い兆候である（GSI は結果整合なので断定はせず、必ず
   `touchClaim` で裏を取る）。30秒待たずに気づける。
3. 実行中のジョブは**二度 claim しない**。claim し直すと同名コンテナ
   （`sattori-job-{jobId}`）の起動に失敗してリトライを1回無駄に消費し、
   実行中スロットの数え上げも壊れる。

`docker kill` が失敗した場合は「停止済み」として扱わず、成功するまで次の確認周期で
再試行する。止められていないコンテナを止めたことにすると、そのコンテナが録画を完走
する一方でデーモンは成否の通知もログも省いてしまい、二重録画が誰にも気づかれない。

それでも「気づく前にコンテナが完走してしまう」窓は残る（特に緊急停止は EC2 の
`TerminateInstances` と違って同期的に止められない）。その窓は**デーモンではなく
ジョブレコード側**で受け止める: 緊急停止は後始末より先に `stopRequestedAt` を立て、
ワーカーの status 書き込みは `attribute_not_exists(stopRequestedAt)` を条件にしか
通らない（`worker/status.py`）。停止したジョブが `done` に戻って完了メールが飛ぶ、
という最悪の結果はここで止まる。

自宅マシンの停電・回線断・クラッシュは AWS 側から一切観測できない。これを検知して
`HandleFailure` を起動するのが、`Launch` タスクの **ハートビートタイムアウト（15分）**
である（ワーカーコンテナが60秒ごとに `SendTaskHeartbeat` を送る。
`worker/task_heartbeat.py`）。デーモンごと死ねば15分でジョブが失敗扱いになり、
claim が解除され、EC2 でリトライされる。

> **デプロイ順序の注意**: このハートビートを送らない古いワーカーイメージが ECR に
> 残っていると、全ジョブが15分でタイムアウトする。ワーカーイメージの push を
> `cdk deploy` より先に行うこと（`infra/README.md`）。

## 4. 設定

構築・更新の手順（IAM の二段構え・ビルド・systemd ユニット・デプロイ順序）は
[`docs/runbooks/home-worker-setup.md`](../docs/runbooks/home-worker-setup.md) にある。
ここには設定項目そのものだけを置く。

### 4.1 環境変数

必須（`cdk deploy` の CfnOutput をそのまま使う）:

| 変数 | 説明 |
| --- | --- |
| `JOBS_TABLE` | CfnOutput `JobsTableName` |
| `WORKERS_TABLE` | CfnOutput `WorkersTableName` |
| `WORKER_IMAGE` | CfnOutput `WorkerRepoUri` + `:latest` |

任意:

| 変数 | 既定 | 説明 |
| --- | --- | --- |
| `AWS_REGION` | `eu-south-2` | 本体スタックのリージョン |
| `HOME_WORKER_ROLE_ARN` | (なし) | CfnOutput `HomeWorkerRoleArn`。**本番では必ず指定する**（未指定だと環境の認証情報をそのままコンテナへ渡す） |
| `HOME_WORKER_ID` | `home-1` | ワーカー識別子。複数台にするなら一意にすること |
| `HOME_WORKER_MAX_CONCURRENCY` | `2` | 同時録画数の上限。**上げる前に「実機検証の記録」を読むこと** — 2並列でもCPU温度が上限に張り付くため、安全な並列度は冷却状態とホストの他負荷に依存する |
| `HOME_WORKER_SUPPORTED_GAMES` | `th06,th07,th08,th11,th20` | 引き受けるタイトル |
| `HOME_WORKER_CAPABILITIES` | `WORKER_CAPABILITIES` 全部（現状 `slow-motion-recording` のみ） | 追加能力（`packages/shared/src/worker.ts`）。低速録画（Issue #68）の実体は EC2 と共通のワーカーイメージ側にあり、デーモンは `homeWorkerEnv` をそのまま `docker run` へ渡すだけなので、自宅ワーカーは無条件に対応できる＝既定で全部宣言する。**「対応はできるが引き受けたくない」場合は空文字（`HOME_WORKER_CAPABILITIES=`）で降りられる**（変数ごと消すと既定に戻るので効かない） |
| `HOME_WORKER_LOAD_THRESHOLD` | `0.7` | 1コアあたりのロードアベレージがこれを超えている間は新規 claim を止める |
| `HOME_WORKER_POLL_INTERVAL_SEC` | `3` | オファー探索の間隔 |
| `HOME_WORKER_DOCKER_CPUS` | (なし) | `docker run --cpus` |
| `HOME_WORKER_DOCKER_ARGS` | (なし) | `docker run` への追加引数（シェルと同じ空白区切り） |
| `HOME_WORKER_DRAIN_TIMEOUT_SEC` | `9000` | 終了シグナル後、実行中ジョブの完走を待つ上限。低速録画（Issue #68）の録画タイムアウト（120分＝等倍60分の2倍）＋変換の余裕（30分）で、Step Functions 側の `taskTimeout`（150分）と揃えてある。**短くすると AWS 側がまだ待っているジョブをデーモンが先に打ち切ることになる** |
| `WORKER_LOG_GROUP` | `/sattori/worker` | ログ転送先（EC2 ワーカーと同じ） |

### 4.2 モジュール構成

| ファイル | 役割 |
| --- | --- |
| `src/main.ts` | エントリポイント。設定読み込みとシグナルハンドラの登録だけ |
| `src/daemon.ts` | メインループ。ハートビート・claim・コンテナ実行・claim監視・ドレイン |
| `src/config.ts` | 環境変数から設定を組み立てる（§4.1 の表がそのまま対応する） |
| `src/credentials.ts` | `sts:AssumeRole` による短命クレデンシャルの発行と期限管理 |
| `src/claim.ts` | オファーの探索（GSI Query）と claim/解放の条件付き更新。**AWS 側との契約そのもの** |
| `src/heartbeat.ts` | `WorkersTable` への自己申告（型は `@sattori/shared` の `WorkerHeartbeat`） |
| `src/capacity.ts` | 余力判定（同時実行上限・ロードアベレージ）。新規 claim を止めるだけ |
| `src/runner.ts` | `docker login` / `docker pull` / `docker run` / `docker kill` |
| `src/logShipper.ts` | コンテナ出力を CloudWatch Logs へ転送（件数とバイト数でバッチを切り、失敗しても転送は諦めない） |
| `src/signal.ts` | 中断できる待機（Python 版の `threading.Event` に相当） |

## 5. 運用

- **一時的に止めたい**: `systemctl stop sattori-home-worker`。ハートビートが途絶えれば
  AWS 側は45秒でオファーをやめ、以後すべて EC2 へ流れる。実行中のジョブは完走を待つ。
- **CPU を空けたい**: `HOME_WORKER_LOAD_THRESHOLD` を下げる。新規 claim だけが止まり、
  走っている録画は最後まで完走する（途中で落とすと丸ごとやり直しになり、節約した
  CPU 時間よりはるかに大きな無駄になるため。Issue #49 論点4）。**逆に言うと、
  走り出した録画がホストの他負荷で劣化するのは防げない**（「実機検証の記録」参照）。
- **どのジョブを自宅が処理したか**: 管理画面のジョブ一覧の `worker` 列、詳細画面の
  `workerKind` / `assignedWorkerId`、コストページのバケットに出る「自宅N件」。
  自宅ワーカーのジョブは EC2/EBS/IPv4 の課金が発生しないため、コスト推定は0で計上する
  （`packages/shared/src/cost.ts`。自宅の電気代・回線費は AWS の請求に現れないので
  このモジュールでは一切計上しない）。
- **ログ**: コンテナ出力は EC2 ワーカーと同じ `/sattori/worker` の `{jobId}` ストリームへ
  転送されるので、管理画面のログ表示（Issue #58）がそのまま使える。デーモン自身の
  ログは `journalctl -u sattori-home-worker`。

## 6. 実機検証の記録

開発マシン（AMD Ryzen 7 5700X、8コア16スレッド / 94GiB）でフル尺のリプレイを1並列・2並列で
録画した実測は
[`docs/reports/2026-08-09-home-worker-parallel-recording.md`](../docs/reports/2026-08-09-home-worker-parallel-recording.md)。

結論だけ引くと、**破綻の条件は「2並列であること」ではなく「サーマル上限に張り付いた状態へ、
さらに外部負荷が乗ること」**である。運用上の含意は3つ:

- **「何並列まで大丈夫か」は固定の数字では決まらない**。`HOME_WORKER_MAX_CONCURRENCY` の
  既定を2に留めているのはこのため。**上げる前に必ず上記レポートと同じ手順で実測すること。**
- `HOME_WORKER_LOAD_THRESHOLD`（既定0.7）は**新規claimを止めるだけで、走り出した録画の
  劣化は防げない**。
- ワーカー内蔵の重複フレーム率チェックは録画開始15〜45秒しか見ないため、**録画途中の劣化を
  検知できない**（Issue #93）。

## 7. 低速録画（Issue #68）と th20 の振り分け

th20（東方錦上京、Issue #87）は描画負荷が高く、等倍で録るなら4xlarge級のインスタンスが要る。
録画品質を担保するには 1/2 倍速で録画して後処理で等速へ戻す方式（Issue #68）が有効だが、
録画に倍の実時間がかかるため EC2 では割に合わない。そこで
**「低速録画できる自宅ワーカーが空いていれば自宅で低速録画、いなければ4xlarge級の EC2 で
等速録画」**という振り分けになっている。

- **能力の宣言**: デーモンは既定で `slow-motion-recording` を宣言する（§4.1 の
  `HOME_WORKER_CAPABILITIES`）。宣言の実体はワーカーコンテナ側にあるので、
  デーモンが何か特別なことをするわけではない。
- **オファーの条件**: 低速録画を希望するジョブは、この能力を宣言したワーカーにしか
  オファーされない（`apps/api/src/workerRouting.ts` の `routingPolicyFor()`）。
  th20 はオファー待ちの上限（`MAX_OFFER_WINDOW_SECONDS`）まで自宅ワーカーを待つ。
- **録画速度の指定**: デーモンは録画速度を一切知らない。AWS 側がオファーに添える
  `homeWorkerEnv` に `FPS_LIMIT_TARGET_HZ=30` が入っているかどうかがすべてで、
  デーモンはそれをそのまま `docker run -e` へ渡す（`apps/api/src/workerEnv.ts`）。
  **EC2 起動時はこの変数を付けない**ので、同じイメージが等倍で走る。
- **所要時間**: 録画フェーズが実時間で2倍になるため、`HOME_WORKER_DRAIN_TIMEOUT_SEC`
  の既定と Step Functions の `taskTimeout` を 150 分に揃えてある（§4.1）。
  1本の th20 で自宅マシンを1時間以上占有することになる点に注意。

ワーカーコンテナ側の実装（Present フックによるスローモーション化、DirectSound の
周波数スケール、録画後の等倍変換）は `worker/README.md` §5 と
`docs/decisions/0014-slow-motion-scaling-across-pipeline.md` を参照。

> **デーモン側に録画速度の判断を持ち込まないこと。** 「起動側が渡す環境変数だけで表す」と
> 決めた理由は
> [`docs/decisions/0010`](../docs/decisions/0010-slow-motion-no-worker-side-branching.md)。

## 8. テスト

```bash
pnpm --filter @sattori/home-worker test        # 単体で走らせる場合
pnpm test                                       # turbo で全パッケージ横断
```

AWS 呼び出しは `aws-sdk-client-mock` で差し替え（`apps/api` と同じ方針）、`docker` の
実行は `RunCommand` / `SpawnContainer` を注入して差し替えるため、実際のクラウド資源にも
docker デーモンにも触れない。

テストで特に守っているのは以下の判断（＝壊すと二重録画・課金事故に直結するもの）:

- claim が取り消されていたらコンテナを止める（`watchClaim`）。一時的なAPIエラーでは止めない。
- `docker kill` が失敗したら停止済みとして扱わず再試行する。
- 対応外タイトルのオファーは claim しない／空きスロットを超えて claim しない。
- 実行中のジョブが再オファーされても claim し直さず、取り消しを確かめて停止する
  （まだ自分のものなら GSI の残像とみなして何もしない）。
- claim が例外になったら自分名義の claim を解除して打ち切る（誰も実行しない claim を
  残さない）。
- claim の条件式に `attribute_not_exists(assignedWorkerId)` と期限判定が入っている。
- claim 直後に空き状況のハートビートを書き直す（満杯なのに「空きあり」と見せない）。
- コンテナへ渡す認証情報の残存時間が足りなければ assume し直す。
- ログ転送に失敗しても録画を止めず、**以降の転送も諦めない**（うるさい失敗ログの方を
  間引く）。バイト数の上限でもバッチを切る——1MiB超のリクエストは再試行しても通らない
  400で丸ごと捨てられるため、件数だけでは守れない。自宅ワーカーのジョブには
  `instanceId` が無く管理画面の `GetConsoleOutput` フォールバックも効かないので、
  ここで捨てたログには控えが無い。
- `docker run` のログ出力で `TASK_TOKEN` と AWS 認証情報が伏せられている。
