---
name: process-dependabot-prs
description: Dependabot が作成した依存パッケージ更新 PR を gVisor サンドボックス内で安全に検査・自動修復し、マージ・本番 AWS デプロイ・E2E 実機検証・異常時ロールバックまでを一貫して行う手順。「Dependabot PR を処理して」「依存アップデートを自動マージ・デプロイして」等で使う。未信頼パッケージによるクレデンシャル窃取防止（Phase A）とデプロイ順序制約（Phase B）を守るため、必ずこの手順に従うこと。
---

# Dependabot PR の自動評価・マージ・デプロイ・検証（Issue #341）

GitHub Dependabot（`.github/dependabot.yml`）が週次で作成する依存パッケージ更新 PR を処理し、本番環境へのデプロイと E2E 検証までを完結させる手順。

**最大の原則は「Phase A（未信頼コードの隔離検査）と Phase B（本番認証情報を使うデプロイ）の分離」である**（[`decisions/0069`](../../../docs/decisions/0069-automated-dependabot-merge-deploy-with-gvisor-sandbox.md)）。未検証の PR ブランチを、AWS 認証情報や SSH 鍵が見えるホスト上で直接 `pnpm install` / `pnpm test` してはならない。

---

## 0. オープンな Dependabot PR の確認

```bash
gh pr list --repo hakatashi/sattori-dev --author "app/dependabot" \
  --json number,title,headRefName,statusCheckRollup
```

複数の PR がある場合は、影響範囲の小さい順（`github-actions` → `dev-test-tools` → `web-deps` → `aws-sdk` / `aws-cdk` → `worker-python` → 個別 Major 更新）に1本ずつ処理する。

---

## 1. Phase A: gVisor サンドボックス内での安全性・互換性検査（Untrusted）

ホストの AWS 認証情報・SSH 鍵を一切マウントせず、自宅 LAN への通信も遮断した `agent-sandbox`（gVisor `runsc` ランタイム、`~/ops/agent-sandbox.md`）内で PR を検証する。

```bash
chmod +x scripts/verify-dependabot-pr-sandbox.sh
scripts/verify-dependabot-pr-sandbox.sh <PR番号> --fix-with-claude
```

このスクリプトは以下の検査を自動実行する:
1. **ロックファイル監査（ホスト側・コード非実行）**:
   - `pnpm-lock.yaml` の差分に新規の `hasInstallScript: true` が含まれていないこと（含まれていれば終了コード `2` で即拒否）。
   - `worker/requirements*.txt` の全行が `==` でピン留めされていること。
2. **リリース後クールダウンの確認**:
   - Dependabot の **Security Updates（脆弱性対応 PR）** は仕様上 `cooldown` をバイパスして即座に作られることがある。PR が Security Update の場合は、更新対象パッケージの公開日時（`npm view <pkg>@<ver> time` または PyPI JSON API）を確認し、公開から5日未満であれば、対象 Advisory（CVE）が本物かつ緊急かを必ず確認する（偽装セキュリティパッチによるサプライチェーン攻撃を防ぐため）。
3. **隔離コンテナ内でのビルド・型チェック・テスト・`cdk synth`**:
   - メジャーアップデート等でテストや型チェックが落ちた場合、`--fix-with-claude` により隔離サンドボックス内の Claude Code がマイグレーション修正を試み、成功すれば `/tmp/sattori-pr-<PR番号>-fix.patch` を出力して終了コード `10` を返す。
   - 終了コード `10` の場合は、出力されたパッチの中身を目視・差分で確認（悪意ある変更やテスト削除が無いかチェック）した上で PR ブランチへ適用・push し、GitHub Actions CI の再通過を待つ。

---

## 2. Phase B: マージ・本番デプロイ・E2E 検証（Trusted）

Phase A と GitHub Actions CI（`Test/test` および `Test/mods-build-smoketest`）の両方がグリーンであることを確認してから、ホスト側でマージとデプロイに進む。

### 2.1 `aws-cdk-lib` / `infra/` 更新時の事前 `cdk diff` チェック（重要）

CDK 関連パッケージが更新されている場合、**マージ前に** CloudFormation の合成差分にステートフルリソース（`AWS::DynamoDB::Table`、`AWS::S3::Bucket`）の **Replacement（再作成＝データ消失）** が含まれていないかを確認する。

```bash
pnpm --filter @sattori/infra exec cdk diff --all
```

出力に `requires replacement` がステートフルリソースに対して出ている場合は、**絶対に自動マージ・デプロイせず、PR にコメントを残して人間にエスカレーションする**。

### 2.2 Merge Commit 方式でのマージと `main` の更新

[`docs/runbooks/issue-workflow.md`](../../../docs/runbooks/issue-workflow.md) §4 に従い、必ず `--merge`（merge commit 方式）でマージする。

```bash
gh pr merge <PR番号> --repo hakatashi/sattori-dev --merge --delete-branch
git checkout main && git pull --ff-only origin main
pnpm install --frozen-lockfile
pnpm build
```

### 2.3 変更ファイルに応じたデプロイ実行（順序厳守）

直前のマージコミットの変更ファイル（`git diff --name-only HEAD~1 HEAD`）から、以下のマトリクスに従ってデプロイを実行する（詳細なコマンドは `deploy-sattori` skill を参照）。

**【鉄則】`worker/` と AWS 本体スタックの両方をデプロイする場合は、必ず「① ECR push（レプリカ到着確認含む）→ ② `cdk deploy` → ③ `sattori-home-worker` 再起動」の順に行うこと**（`deploy-sattori` skill §1）。

| 変更されたファイル群 | ① ECR Build & Push | ② CDK Deploy | ③ `home-worker` 再起動 | ④ 検証内容 |
| --- | --- | --- | --- | --- |
| `.github/workflows/*` のみ | 不要 | 不要 | 不要 | CI のみで完了 |
| `worker/requirements-docker.txt` または `worker/Dockerfile*` | **必須**（CPU/GPU 両イメージ build & push + `eu-north-1` レプリカ到着確認） | 不要 | 不要 | **ローカル Docker 録画検証**（§2.4） |
| `apps/web/*` のみ | 不要 | **必須** | 不要 | `curl -sfI https://sattori.hakatashi.com/` |
| `apps/api/*`, `packages/*`, `infra/*`, ルート依存 | 不要 | **必須** | `@sattori/shared` 変更時のみ | API 疎通 + **Major 更新・SDK 更新時は本番 E2E 録画 1本**（§2.4） |
| `home-worker/*` | 不要 | 不要 | **必須**（稼働中なら `sudo systemctl restart sattori-home-worker`） | `systemctl is-active sattori-home-worker` |

非対話での CDK デプロイコマンド（全3スタックが `✅` になることを確認する）:

```bash
source scripts/sattori-env.sh
pnpm --filter @sattori/infra exec cdk deploy --all --require-approval never
```

### 2.4 実機スモーク検証（Local / Production E2E）

単体テストだけでは検出できないバンドル不整合やランタイムエラーを検知するため、以下のいずれかの変更を含む場合は実機検証を1本流す:
- **対象条件**: メジャーアップデート、`@aws-sdk/*`、`aws-cdk-lib`、`worker/requirements-docker.txt`

1. **Worker (`requirements-docker.txt`) の変更時**:
   `verify-recording-locally` skill の手順に従い（`sattori-home-worker` が停止中であることを確認した上で）、短いリプレイ（例: `th06` 1面リプレイ）をローカル Docker コンテナで録画し、正常終了することを確認する。
2. **Lambda / SDK / CDK / メジャーアップデート時**:
   `verify-recording-in-production` skill §5〜§6 の API 直接呼び出し手順で、`packages/replay-parser/test-fixtures/th06/` の短いリプレイを1本投入し、`status === "done"` かつ `desyncDetected === false` で完走することを確認する。

---

## 3. 異常検知時の自動ロールバック

デプロイ失敗、または §2.4 の E2E カナリア検証でジョブが `failed` になった場合は、直ちに以下の手順で本番環境を正常状態へ巻き戻す:

1. **Git リバートと push**:
   ```bash
   git revert -m 1 HEAD --no-edit
   git push origin main
   pnpm install --frozen-lockfile
   pnpm build
   ```
2. **巻き戻しデプロイ**:
   - `worker/` を変更していた場合は、リバート後のソースで `sattori-worker:latest` / `sattori-worker-gpu:latest` を再ビルド・push し、`eu-north-1` レプリカ到着を確認する。
   - `pnpm --filter @sattori/infra exec cdk deploy --all --require-approval never` を実行する。
   - `sattori-home-worker` を再起動していた場合は再起動する。
3. **インシデント Issue の起票**:
   `gh issue create --repo hakatashi/sattori-dev --label bug` で失敗ログとロールバック完了報告を記録する。

---

## 関連

- 本番デプロイ手順の詳細 → `deploy-sattori` skill
- ローカル Docker での録画検証 → `verify-recording-locally` skill
- 本番 AWS での E2E 録画検証 → `verify-recording-in-production` skill
- サプライチェーン対策と Dependabot 採用の決定記録 → [`decisions/0068`](../../../docs/decisions/0068-supply-chain-cooldown-and-dependabot.md)
- 二段階分離（gVisor サンドボックス検査＋ホストデプロイ）の決定記録 → [`decisions/0069`](../../../docs/decisions/0069-automated-dependabot-merge-deploy-with-gvisor-sandbox.md)
