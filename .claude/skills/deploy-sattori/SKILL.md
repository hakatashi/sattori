---
name: deploy-sattori
description: Sattori を AWS へデプロイする（CDK デプロイ、ワーカーの Docker イメージの再ビルドと ECR への push、管理画面トークンの SSM 投入・ローテーション）。「デプロイして」「worker のイメージを更新して」「admin トークンを入れ替えて」等で使う。push と deploy の順序を守らないと全ジョブがタイムアウトするため、必ずこの手順に従うこと。
---

# Sattori のデプロイ

Sattori 本体（`SattoriStack`、リージョン `eu-south-2`）と録画ワーカーイメージのデプロイ手順。
**ワーカーイメージを変更した場合の順序（push → deploy）が最も重要**なので §1 を必ず読むこと。

## 0. 環境値の解決

AWS アカウントID・S3 バケット名はリポジトリにコミットしていない。最初に解決しておく。

```bash
source scripts/sattori-env.sh
# SATTORI_REGION / SATTORI_AWS_ACCOUNT_ID / SATTORI_ECR_REPO /
# SATTORI_TITLE_ASSETS_BUCKET が使えるようになる
```

## 1. ビルド・デプロイ

**`worker/` を変更した場合は、先に `docker push` を済ませること**（§2）。順序はこうなる:

```bash
pnpm build
# worker/ を変更した場合はここで docker build && docker push（§2）
pnpm run deploy
```

> 注: `pnpm deploy`（`run` なし）は pnpm の組み込みコマンドと名前が衝突するため使えない。
> 必ず `pnpm run deploy` と明示すること。
>
> 注: IAM・セキュリティグループの変更を含むデプロイでは、`cdk deploy`が承認を求めて
> 対話入力を待つ。非対話の環境（エージェントの実行等）では入力が来ないまま**そのスタックを
> スキップして正常終了したように見える**（2026-10-11、`SattoriStack`だけ更新されなかった）。
> `pnpm run deploy -- --require-approval never`では2段のpnpmスクリプトを越えて渡らないため、
> 非対話で流すときは
> `pnpm --filter @sattori/infra exec cdk deploy --all --require-approval never`を使い、
> 各スタックが`✅`で終わったことを確認すること。

### なぜ push が先なのか（順序を逆にすると事故になる）

`Launch` タスクには**ハートビートタイムアウト（15分、Issue #49）**が入っている。
`SendTaskHeartbeat` を送らない古いワーカーイメージが ECR に残っている状態で
ステートマシンだけ先にデプロイすると、**全ジョブが15分でタイムアウトして最大10回
リトライされる**（`infra/README.md`「ワーカー」、`home-worker/README.md` §3）。

逆順にしてしまった場合は、`docker push` を済ませてから失敗したジョブを管理画面の
再実行（`/admin`、Issue #59）で流し直す。

なおイメージを変更していないデプロイでは順序は問題にならない。

### 自宅ワーカーを動かしている場合

常駐デーモン（Issue #49）は `home-worker/dist/` を直接実行しているため、
`pnpm build` 後に再起動が必要:

```bash
sudo systemctl restart sattori-home-worker
```

実行中の録画を完走させてから終了するので、再起動には最大 `TimeoutStopSec` かかる。

## 2. ワーカーイメージの再ビルド・push

**`pnpm run deploy` より先に実行すること**（理由は §1）。

```bash
source scripts/sattori-env.sh
docker build -t "${SATTORI_ECR_REPO}:latest" worker/
aws ecr get-login-password --region "$SATTORI_REGION" \
  | docker login --username AWS --password-stdin \
      "${SATTORI_AWS_ACCOUNT_ID}.dkr.ecr.${SATTORI_REGION}.amazonaws.com"
docker push "${SATTORI_ECR_REPO}:latest"
```

> 2026-08 の eu-south-2 移設に伴い、ECR リポジトリも eu-south-2 側。旧 us-east-1 の
> イメージは参照されない。

### GPU描画必須タイトル(th06nc等)専用イメージ(`worker-gpu`)

**§1と同様、`pnpm run deploy`より先に実行すること。** CPU系イメージとは別Dockerfile
（`Dockerfile.gpu`）・別ECRリポジトリで、th06nc(Issue #241)を変更した場合のみ再ビルド・
push すればよい（CPU系9タイトルの変更では不要）。

```bash
source scripts/sattori-env.sh
docker build -f worker/Dockerfile.gpu -t "${SATTORI_ECR_GPU_REPO}:latest" worker/
aws ecr get-login-password --region "$SATTORI_REGION" \
  | docker login --username AWS --password-stdin \
      "${SATTORI_AWS_ACCOUNT_ID}.dkr.ecr.${SATTORI_REGION}.amazonaws.com"
docker push "${SATTORI_ECR_GPU_REPO}:latest"
```

**pushしたらeu-north-1のレプリカへの到着を確認してから`pnpm run deploy`へ進むこと**
（Issue #296）。GPUジョブはeu-south-2の容量不足時にeu-north-1で起動し、そのリージョンの
ECRレプリカからpullする。ECRのレジストリ複製は数分で終わるが非同期なので、到着前に
フォールバック先で起動すると古いイメージで録画される。

```bash
SRC=$(aws ecr describe-images --region "$SATTORI_REGION" --repository-name sattori-worker-gpu \
  --image-ids imageTag=latest --query 'imageDetails[0].imageDigest' --output text)
until [ "$(aws ecr describe-images --region eu-north-1 --repository-name sattori-worker-gpu \
  --image-ids imageTag=latest --query 'imageDetails[0].imageDigest' --output text 2>/dev/null)" = "$SRC" ]; do
  echo "レプリカ待ち…"; sleep 15
done
```

**複製は複製設定（`SattoriStack`の`WorkerGpuReplication`）より後のpushにしか効かない**。
複製設定を初めてデプロイした直後はレプリカが空なので、§4の初回手順で種を撒く。
**中身の変わらないイメージを`docker push`し直しても複製は起きない**（ECRにとって同一
マニフェストの再pushは何もしない操作で、`describe-image-replication-status`も空のまま。
2026-10-11の初回セットアップで確認）。

**GPU用カスタムAMI（`build-gpu-worker-ami` skill）を更新した場合は、このイメージの
再ビルド・再pushもセットで行うこと。** AMI側のNVIDIA GRIDドライバのバージョンと
コンテナが期待するユーザースペースライブラリのバージョンが食い違うと、Xorg/DXVKの
起動に失敗する可能性がある（`worker/docs/titles/th06nc.md`参照）。

## 3. 管理画面（`/admin`）トークンの投入・ローテーション

管理画面は SSM Parameter Store（SecureString）に置いた共有トークンで認証する（Issue #51）。
**SecureString は CDK/CloudFormation では作成できない**ため、`cdk deploy` より前に手動で
作成しておくこと（無くてもデプロイ自体は失敗しないが、作成するまで `/admin/*` は全て403）。

投入・ローテーション（漏洩時等）はどちらも同じコマンド:

```bash
aws ssm put-parameter --region "$SATTORI_REGION" --name /sattori/admin/token \
  --type SecureString --value "$(openssl rand -hex 32)" --overwrite
```

ブラウザ側（`https://sattori.hakatashi.com/admin`）のログインフォームに貼る値の確認:

```bash
aws ssm get-parameter --region "$SATTORI_REGION" --name /sattori/admin/token \
  --with-decryption --query Parameter.Value --output text
```

> Lambda Authorizer 側に SSM 取得結果のキャッシュ（5分）と API Gateway 側の authorizer
> `resultsCache`（5分）があるため、**旧トークンの失効反映は最大10分遅れる**。

## 4. GPUフォールバック先（eu-north-1）の初回セットアップ（Issue #296）

`SattoriGpuFallbackStack`を初めてデプロイするときだけ行う（[`decisions/0061`](../../../docs/decisions/0061-gpu-capacity-fallback-to-eu-north-1.md)、
`infra/README.md`）。順序を守らないと、ECRが受け皿のリポジトリを自動作成してスタックの作成が衝突する。

1. GPU AMIをeu-north-1へコピーし、`infra/cdk.json`の`gpuWorkerAmiIds`に`eu-north-1`を足して
   コミットする（`build-gpu-worker-ami` skill §5.5・§6）。
2. eu-north-1をbootstrapする: `pnpm --filter @sattori/infra exec cdk bootstrap aws://${SATTORI_AWS_ACCOUNT_ID}/eu-north-1`
3. フォールバックスタックを本体より先にデプロイする:
   `pnpm --filter @sattori/infra exec cdk deploy SattoriGpuFallbackStack`
4. §2のとおりCPU系・GPU系の両イメージをpushする（このときはまだ複製設定が無いので複製されない）。
5. `pnpm run deploy`で本体（複製設定・固定名のインスタンスプロファイル・Lambdaの環境変数）を
   デプロイする。
6. レプリカへイメージを届ける。上の注意のとおり同じイメージの再pushは効かないので、
   **別タグを付けて複製を起こし、レプリカ側で`latest`を原本と同一バイトのマニフェストで付ける**。
   マニフェストは`jq`等で整形し直さないこと（空白が変わると別ダイジェストの別イメージになる）。

   ```bash
   SEED=replication-seed-$(date +%Y%m%d)
   aws ecr batch-get-image --region eu-south-2 --repository-name sattori-worker-gpu \
     --image-ids imageTag=latest --accepted-media-types application/vnd.oci.image.index.v1+json \
     --query 'images[0].imageManifest' --output text > /tmp/gpu-manifest.json
   aws ecr put-image --region eu-south-2 --repository-name sattori-worker-gpu --image-tag "$SEED" \
     --image-manifest "$(cat /tmp/gpu-manifest.json)" --image-manifest-media-type application/vnd.oci.image.index.v1+json
   # 複製の完了を待つ（COMPLETEになるまで）
   aws ecr describe-image-replication-status --region eu-south-2 --repository-name sattori-worker-gpu \
     --image-id imageTag="$SEED" --query 'replicationStatuses[0].status'
   aws ecr put-image --region eu-north-1 --repository-name sattori-worker-gpu --image-tag latest \
     --image-manifest "$(cat /tmp/gpu-manifest.json)" --image-manifest-media-type application/vnd.oci.image.index.v1+json
   # 種のタグは両リージョンで消す（タグだけのつもりでも世代数のライフサイクルを1枠使うため）
   for r in eu-south-2 eu-north-1; do
     aws ecr batch-delete-image --region $r --repository-name sattori-worker-gpu --image-ids imageTag="$SEED"
   done
   ```

   最後に§2のレプリカ到着確認（ダイジェストの一致）を通す。2回目以降は、中身の変わった
   イメージのpushで自動的に複製されるのでこの手順は要らない。
7. 管理画面の設定で「GPUフォールバックリージョンの強制」を有効にし、`verify-recording-in-production`
   skillの方法でth06nc・th15・倍速録画を1本ずつ流す。終わったら必ず解除する。

eu-north-1のG系Spotクォータ（L-3819A6DF）も確認しておく。2026-10-11時点では8 vCPU
（g6f.2xlarge 1台分）のままだった（`docs/known-limitations.md` §5）。

## 関連

- タイトル資産（ゲームデータ）の S3 アップロード → `upload-title-assets` skill
- MOD（`*_hook.dll`）のビルド → `build-mods` skill
- GPU用カスタムAMI（th06nc等、Issue #241）の構築 → `build-gpu-worker-ami` skill
- スタック構成・CDK の詳細 → `infra/README.md`
