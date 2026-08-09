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
| `HOME_WORKER_MAX_CONCURRENCY` | `2` | 同時録画数の上限。**上げる前に「実機検証の記録」を読むこと** — 2並列でもCPU温度が上限に張り付くため、安全な並列度は冷却状態とホストの他負荷に依存する |
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

開発マシン（AMD Ryzen 7 5700X、8コア16スレッド / 94GiB）でフル尺のリプレイを録画した
記録（2026-08-09）。コンテナの起動は `runner.py` の `build_docker_command()` /
`ContainerRun` を実際に使い、タイトル資産の取得・リプレイ取得・出力アップロードは
本番と同じ eu-south-2 の S3 バケットを通した。`JOBS_TABLE` は未指定（本番の
JobsTable を汚さないため）、`TASK_TOKEN` はダミー（Step Functions の実行が無いため）。

### 6.1 結果

3回のランを比較した。**処理落ちの指標には ffmpeg 自身の `dup`/`drop` カウンタ**
（`worker/runs/{jobId}/ffmpeg_video.log`）を使う。これは「入力フレームが間に合わず
複製した／捨てた」枚数そのもので、60で割れば失われた秒数になる。

| ラン | フレーム数 | dup | drop | 録画時間 | 重複フレーム率(15〜45秒) |
| --- | --- | --- | --- | --- | --- |
| 1並列 th07 | 124982 | 2 | 0 | 2084.8秒 | 0.4% |
| 2並列 th07 | 124954 | 3 | 0 | 2086.2秒 | 7.2% |
| 2並列 th08 | 117175 | 3 | 0 | 1955.1秒 | 0.2% |
| **劣化した回** 2並列 th07 | 133631 | **318** | **315** | 2229.0秒 | 6.9% |
| **劣化した回** 2並列 th08 | 125724 | **495** | **491** | 2097.5秒 | 20.6% |

「劣化した回」では目視で1〜2秒の処理落ちが複数回確認でき、`dup` の増分を1分刻みで
見ると全編に散発していた（両ジョブで**同時刻に**スパイクする＝ホスト側の要因）。
同じ2並列でも後日の再現実行では `dup=3`/`drop=0` と、1並列（`dup=2`）とほぼ同一だった。

### 6.2 何が効いていたか

**(a) CPU温度**。録画中のCPU温度は 1並列で Tctl 中央80.8℃/最大88.1℃、2並列で
**中央91.0℃/最大93.8℃**（Tccd は最大99.2℃）。5700X の最大動作温度は90℃なので、
**2並列の録画中は常時サーマル上限に張り付いている**。CPU競合の指標（PSIの
`cpu some` stall）も 21.8 → 79.8 ms/s（p95 126.2 ms/s）と3倍以上になる。

**(b) ホストの他負荷**。劣化した回だけ、sysstat の履歴で ldavg 11〜27・`%nice`
4.7〜6.8%（nice値付きの別プロセスが約1コア分）・`%user` 38〜54% を記録していた。
再現実行時は ldavg 6〜14・`%nice` 0.03%・`%user` 31〜35% で、同じ2並列でも破綻しなかった。

つまり**破綻の条件は「2並列であること」ではなく「サーマル上限に張り付いた状態へ、
さらに外部負荷が乗ること」**である。再現する2並列固有の影響は、録画開始15〜45秒の
重複フレーム率が 0.4%→7.2% に上がる程度（録画の総時間は変わらない）に留まる。

### 6.3 運用上の含意

- **「何並列まで大丈夫か」は固定の数字では決まらない**。冷却状態と、そのときホストで
  他に何が動いているかで変わる。`HOME_WORKER_MAX_CONCURRENCY` の既定を2に留めているのは
  このため。上げる前に必ずこの節の手順で実測すること。
- `HOME_WORKER_LOAD_THRESHOLD`（既定0.7）は**新規claimを止めるだけで、走り出した録画の
  劣化は防げない**。劣化した回の ldavg 11〜27 は 16スレッド換算で0.69〜1.7なので、
  デーモン経由であれば新規claimは止まっていた可能性が高い。
- ワーカー内蔵の重複フレーム率チェックは録画開始15〜45秒しか見ないため、
  **録画途中の劣化を検知できない**（劣化した回も6.9%で閾値30%を通過した）。
- 冷却の改善が最も効果の大きい対策になる見込み。

### 6.4 確認できた機能面

2並列・1並列いずれも `exit_code=0` で完走し、元解像度版・720p版とも正常に生成・
アップロードされた。ジョブごとの PulseAudio sink 分離（Issue #48）は両コンテナで機能し、
`task_heartbeat.py` は送信失敗（ダミートークンによる `InvalidToken`）を握りつぶして
録画を継続した。

## 7. 今後の展開

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

## 8. テスト

```bash
cd home-worker
pip install -r requirements-dev.txt
python3 -m pytest
```

AWS 呼び出しと `docker` はすべて差し替えており、実際のクラウド資源には触れない
（`worker/` と同じ方針で moto 等は使わない）。
