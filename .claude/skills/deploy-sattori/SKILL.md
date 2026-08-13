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

## 関連

- タイトル資産（ゲームデータ）の S3 アップロード → `upload-title-assets` skill
- MOD（`*_hook.dll`）のビルド → `build-mods` skill
- スタック構成・CDK の詳細 → `infra/README.md`
