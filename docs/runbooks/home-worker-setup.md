# 自宅サーバー録画ワーカーのセットアップ

自宅サーバーに常駐デーモン（`home-worker/`、Issue #49）を設置して録画ジョブを引き受け
させるまでの手順。IAM の準備・ビルド・systemd への登録を扱う。**何のための仕組みか・
どう動くか（① 参照仕様）は [`home-worker/README.md`](../../home-worker/README.md) にあり、
設定できる環境変数の一覧も同 §4.1 にある**ので、初めて構築するときは先にそちらを読むこと。

## 1. IAM（長期キーを最小化する二段構え）

自宅マシンにはインスタンスプロファイルが無いため、何らかの長期認証情報を置かざるを得ない。
そのリスクを抑えるため、次の二段構えにしてある。

1. CDK が最小権限の **`HomeWorkerRole`** を作る（CfnOutput `HomeWorkerRoleArn`）。
   権限は「アップロードバケットの読み取り／出力バケットの読み書き／タイトル資産の
   読み取り／JobsTable の読み書き／WorkersTable への書き込み／ECR pull／
   CloudWatch Logs への書き込み／`SendTask*`」だけ。
2. **ロールを assume する権限だけを持つ IAM ユーザー**を手動で作り、そのアクセスキーを
   自宅マシンに置く（アクセスキーは CloudFormation で作るべきではないため手動運用。
   管理画面トークンの SSM 投入と同じ方針）。
3. デーモンは起動後 `sts:AssumeRole` して短命クレデンシャル（既定4時間）を得、自身の API
   呼び出しにもワーカーコンテナへ渡す環境変数にも**それだけ**を使う。

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

コンテナへ渡す認証情報は**コンテナ起動の直前**に残存時間を確認し、ジョブ1本ぶん（100分）に
足りなければ assume し直す。コンテナ内には認証情報を再取得する手段が無いため、録画の途中で
期限切れになるとそのジョブは丸ごと無駄になる。

## 2. ビルドと起動

Node 24 と pnpm（リポジトリルートの `.tool-versions`）があればよい。デーモンは
`@sattori/shared` に依存するため、**ビルドはリポジトリルートから**行う（`pnpm build` が
turbo 経由で `@sattori/shared` → `@sattori/home-worker` の順にビルドする）。

```bash
pnpm install
pnpm build          # このデーモンだけなら: pnpm exec turbo run build --filter @sattori/home-worker
cd home-worker
JOBS_TABLE=... WORKERS_TABLE=... WORKER_IMAGE=... HOME_WORKER_ROLE_ARN=... \
  node dist/main.js
```

必須の環境変数（`JOBS_TABLE` / `WORKERS_TABLE` / `WORKER_IMAGE`。値は `cdk deploy` の
CfnOutput をそのまま使う）が欠けている場合は、起動時に「設定エラー」を出して終了コード2で
落ちる。systemd の `Restart=always` で無限に再起動し続けないよう、設定ミスは即座に分かる
ようにしてある。設定できる項目の全体は
[`home-worker/README.md`](../../home-worker/README.md) §4.1。

## 3. systemd への登録

`/etc/systemd/system/sattori-home-worker.service`:

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
ExecStart=/home/hakatashi/.asdf/installs/nodejs/24.9.0/bin/node dist/main.js
Restart=always
RestartSec=10
# 実行中の録画を完走させてから終了する（SIGTERM後は新規claimを止めるだけ）。
# `HOME_WORKER_DRAIN_TIMEOUT_SEC`（既定9000秒＝150分）より必ず長く取ること。
# 短いとドレインの途中で systemd に SIGKILL され、claim のハートビートとログ転送が
# 止まったままコンテナだけが dockerd 配下に取り残される。
KillSignal=SIGTERM
TimeoutStopSec=9600

[Install]
WantedBy=multi-user.target
```

書き方で外してはいけない点が3つある。

- `EnvironmentFile` にはアクセスキーではなく `AWS_PROFILE`（または
  `AWS_SHARED_CREDENTIALS_FILE`）を書き、鍵そのものは `~/.aws/credentials` に置いて
  `chmod 600` にしておくこと。
- `ExecStart` は `dist/` を直接叩く。`pnpm start` を挟むと SIGTERM が pnpm 止まりで Node へ
  届かず、ドレイン——実行中の録画の完走待ち——が働かなくなる。
- Node は **asdf の shim（`~/.asdf/shims/node`）ではなく実体のパスを指定する**。shim の
  中身は `exec asdf exec "node" "$@"` で `asdf` 本体（`/usr/local/bin/asdf`）を PATH から
  探すが、systemd の既定 PATH には `/usr/local/bin` が含まれないため、shim 経由では起動に
  失敗する。実体のパスは `asdf which node` で得られる。ただしこのパスにはバージョンが
  埋まっているので、**asdf で Node を入れ替えたらユニットの更新が要る**（起動しなくなる
  だけで録画が壊れることはないが、`Restart=always` で再起動を繰り返す）。

## 4. 更新のデプロイ

**先に `pnpm build` を済ませてから** `systemctl restart sattori-home-worker` すること。
`ExecStart` はビルド済みの `dist/` を直接起動するため、ビルドを忘れると古いコードのまま
再起動して気づけない。

ワーカーコンテナのイメージ（`worker/`、EC2 と共通）を更新した場合の順序は別で、
**ECR への `docker push` を `cdk deploy` より先に**行う（`deploy-sattori` Skill、
`infra/README.md`）。ハートビートを送らない古いイメージが残っていると全ジョブが15分で
タイムアウトする。
