# home-worker — 自宅サーバー録画ワーカー（Issue #49）

開発者の自宅サーバーがオンラインかつCPUに余裕があるとき、AWS の EC2 Fleet の代わりに
録画ジョブを引き受ける常駐デーモン。EC2 Spot がコストの7割超を占める（`docs/aws-region-cost-analysis.md`）
ため、自宅で処理できたぶんはそのまま丸ごと削減になる。

**録画そのものは EC2 とまったく同じ ECR イメージ（`worker/`）で行う**。このディレクトリに
あるのは「ジョブを取りに行き、コンテナを起動し、ログを転送し、後始末をする」だけの
薄い常駐プロセスであり、録画パイプラインのロジックは一切持たない。

## 1. なぜ Pull 型なのか

自宅マシンは動的グローバルIP・NAT配下にあり、AWS 側から到達させるにはポート開放や
DDNS が要る。「オンラインのときだけ使う」という要件とも噛み合わないため、
**自宅がジョブを取りに行く Pull 型**にしてある（Issue #49 の論点1）。

録画ジョブは Step Functions の `Launch` ステート（`waitForTaskToken`）が
「taskToken を持つ主体が結果を返せば成立する」設計になっているので、EC2 ワーカーと
自宅ワーカーはまったく同じインターフェースで扱える。ステートマシン本体・リトライ
ロジック（`apps/api/src/retryPolicy.ts`）は自宅ワーカーの存在を知らない。

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
**AWS 側がこの属性を消すことが claim の取り消し**を意味し、デーモンは30秒ごとに
「まだ自分のものか」を条件付き更新で確かめ、崩れていたら即座に `docker kill` する。
消す側は2箇所:

- `HandleFailure`（`apps/api/src/handlers/sfn/handleFailure.ts`）— EC2 に対する
  `TerminateInstances` と同じ位置づけの後始末。
- 管理画面からの緊急停止（`POST /admin/jobs/{jobId}/stop`、Issue #59）。

自宅マシンの停電・回線断・クラッシュは AWS 側から一切観測できない。これを検知して
`HandleFailure` を起動するのが、`Launch` タスクの **ハートビートタイムアウト（15分）**
である（ワーカーコンテナが60秒ごとに `SendTaskHeartbeat` を送る。
`worker/task_heartbeat.py`）。デーモンごと死ねば15分でジョブが失敗扱いになり、
claim が解除され、EC2 でリトライされる。

> **デプロイ順序の注意**: このハートビートを送らない古いワーカーイメージが ECR に
> 残っていると、全ジョブが15分でタイムアウトする。ワーカーイメージの push を
> `cdk deploy` より先に行うこと（`infra/README.md`）。

## 4. セットアップ

### 4.1 IAM（長期キーを最小化する二段構え）

自宅マシンにはインスタンスプロファイルが無いため、何らかの長期認証情報を置かざるを
得ない。そのリスクを抑えるため:

1. CDK が最小権限の **`HomeWorkerRole`** を作る（CfnOutput `HomeWorkerRoleArn`）。
   権限は「アップロードバケットの読み取り／出力バケットの読み書き／タイトル資産の
   読み取り／JobsTable の読み書き／WorkersTable への書き込み／ECR pull／
   CloudWatch Logs への書き込み／`SendTask*`」だけ。
2. **ロールを assume する権限だけを持つ IAM ユーザー**を手動で作り、そのアクセスキーを
   自宅マシンに置く（アクセスキーは CloudFormation で作るべきではないため手動運用。
   管理画面トークンの SSM 投入と同じ方針）。
3. デーモンは起動後 `sts:AssumeRole` して短命クレデンシャル（既定4時間）を得、
   自身の API 呼び出しにもワーカーコンテナへ渡す環境変数にも**それだけ**を使う。

万一自宅マシンの鍵が漏れても、直接触れるのは「ロールを assume する」ことだけであり、
ロールを消せば即座に無効化できる。

IAM ユーザー側に付けるポリシー:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "sts:AssumeRole",
      "Resource": "<HomeWorkerRoleArn の値>"
    }
  ]
}
```

コンテナへ渡す認証情報は**コンテナ起動の直前**に残存時間を確認し、ジョブ1本ぶん
（100分）に足りなければ assume し直す。コンテナ内には認証情報を再取得する手段が
無いため、録画の途中で期限切れになるとそのジョブは丸ごと無駄になる。

### 4.2 環境変数

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
| `HOME_WORKER_MAX_CONCURRENCY` | `2` | 同時録画数の上限。自宅マシンは4並列まで処理落ちなく録画できる実績がある（Issue #48・#49）が、既定は控えめにしてある |
| `HOME_WORKER_SUPPORTED_GAMES` | `th06,th07,th08,th11` | 引き受けるタイトル |
| `HOME_WORKER_CAPABILITIES` | (なし) | 追加能力。**実際にできることだけ**を書く（`packages/shared/src/worker.ts`） |
| `HOME_WORKER_LOAD_THRESHOLD` | `0.7` | 1コアあたりのロードアベレージがこれを超えている間は新規 claim を止める |
| `HOME_WORKER_POLL_INTERVAL_SEC` | `3` | オファー探索の間隔 |
| `HOME_WORKER_DOCKER_CPUS` | (なし) | `docker run --cpus` |
| `HOME_WORKER_DOCKER_ARGS` | (なし) | `docker run` への追加引数（シェルと同じ空白区切り） |
| `HOME_WORKER_DRAIN_TIMEOUT_SEC` | `5400` | 終了シグナル後、実行中ジョブの完走を待つ上限 |
| `WORKER_LOG_GROUP` | `/sattori/worker` | ログ転送先（EC2 ワーカーと同じ） |

### 4.3 起動

```bash
cd home-worker
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
JOBS_TABLE=... WORKERS_TABLE=... WORKER_IMAGE=... HOME_WORKER_ROLE_ARN=... \
  python3 daemon.py
```

systemd ユニットの例（`/etc/systemd/system/sattori-home-worker.service`）:

```ini
[Unit]
Description=Sattori home recording worker
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
User=hakatashi
WorkingDirectory=/home/hakatashi/sattori/home-worker
EnvironmentFile=/etc/sattori-home-worker.env
ExecStart=/home/hakatashi/sattori/home-worker/.venv/bin/python3 daemon.py
Restart=always
RestartSec=10
# 実行中の録画を完走させてから終了する（SIGTERM後は新規claimを止めるだけ）。
KillSignal=SIGTERM
TimeoutStopSec=5400

[Install]
WantedBy=multi-user.target
```

`EnvironmentFile` にはアクセスキーではなく `AWS_PROFILE`（または
`AWS_SHARED_CREDENTIALS_FILE`）を書き、鍵そのものは `~/.aws/credentials` に置いて
`chmod 600` にしておくとよい。

## 5. 運用

- **一時的に止めたい**: `systemctl stop sattori-home-worker`。ハートビートが途絶えれば
  AWS 側は45秒でオファーをやめ、以後すべて EC2 へ流れる。実行中のジョブは完走を待つ。
- **CPU を空けたい**: `HOME_WORKER_LOAD_THRESHOLD` を下げる。新規 claim だけが止まり、
  走っている録画は最後まで完走する（途中で落とすと丸ごとやり直しになり、節約した
  CPU 時間よりはるかに大きな無駄になるため。Issue #49 論点4）。
- **どのジョブを自宅が処理したか**: 管理画面のジョブ一覧の `worker` 列、詳細画面の
  `workerKind` / `assignedWorkerId`、コストページのバケットに出る「自宅N件」。
  自宅ワーカーのジョブは EC2/EBS/IPv4 の課金が発生しないため、コスト推定は0で計上する
  （`packages/shared/src/cost.ts`。自宅の電気代・回線費は AWS の請求に現れないので
  このモジュールでは一切計上しない）。
- **ログ**: コンテナ出力は EC2 ワーカーと同じ `/sattori/worker` の `{jobId}` ストリームへ
  転送されるので、管理画面のログ表示（Issue #58）がそのまま使える。デーモン自身の
  ログは `journalctl -u sattori-home-worker`。

## 6. 今後の展開

th20（東方錦上京、Issue #87）は描画負荷が高く、原則として4xlarge級のインスタンスが要る。
録画品質を担保するため 1/2 倍速で録画して後処理で等速へ戻す方式（Issue #68）を採りたいが、
録画に倍の実時間がかかるため EC2 では割に合わない。そこで
**「低速録画できる自宅ワーカーが空いていれば自宅で低速録画、いなければ4xlarge級の EC2 で
等速録画」**という振り分けを行う予定である。

この振り分けは `apps/api/src/workerRouting.ts` の `GAME_ROUTING_POLICIES` に th20 の行を
足すだけで表現できるように設計してある（`requiredCapabilities: ["slow-motion-recording"]`
＋ EC2 側の候補インスタンスタイプを th20 だけ4xlarge級にする）。デーモン側は
`HOME_WORKER_CAPABILITIES=slow-motion-recording` を宣言し、録画速度そのものは
**AWS 側が渡す環境変数**として受け取る——ワーカーコンテナに「自宅かEC2か」の分岐を
持ち込まないため（`apps/api/src/workerEnv.ts`）。

## 7. テスト

```bash
cd home-worker
pip install -r requirements-dev.txt
python3 -m pytest
```

AWS 呼び出しと `docker` はすべて差し替えており、実際のクラウド資源には触れない
（`worker/` と同じ方針で moto 等は使わない）。
