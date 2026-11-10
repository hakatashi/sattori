# 0069. Dependabot PRのAI自動処理はgVisor隔離検査（Phase A）とホスト本番デプロイ（Phase B）の二段階に分離する

- **状態**: 有効
- **決定日**: 2026-11-11
- **対象**: 全パッケージ（`scripts/` / `.claude/skills/`）
- **関連**: Issue #341、[`0068`](0068-supply-chain-cooldown-and-dependabot.md)

Dependabot PR のテスト・互換性確認・マイグレーション修正からマージ・本番 AWS デプロイ・E2E 検証までを AI エージェントで自動化するにあたり、**未信頼パッケージを実行する検査フェーズ（Phase A: gVisor サンドボックス）** と **本番クレデンシャルを使うデプロイ・検証フェーズ（Phase B: ホスト）** を厳格に分離する。

## 背景

[`0068`](0068-supply-chain-cooldown-and-dependabot.md) でリリース後5〜7日間のクールダウンと `onlyBuiltDependencies` を導入したが、以下の残存リスクがある:

1. 5日間発覚しなかった巧妙な悪性コードがテスト実行時（`vitest` や `pytest` によるモジュール import 時）に発火するケース。
2. Dependabot の Security Updates（脆弱性対応 PR）が仕様上クールダウンをバイパスして作成された際、偽装セキュリティパッチが混入するケース。
3. メジャーアップデートを含む自動デプロイで、単体テストは通るが CloudFormation のステートフルリソース再作成（Replacement）や本番ランタイム不整合を引き起こすケース。

もし未検証の PR ブランチを HakataMatrix のホスト環境（AWS 本番クレデンシャル・SSH 鍵・自宅 LAN アクセスを持つ）で直接 `pnpm test` すると、テスト実行中に認証情報が窃取されうる。

## 決定

- **Phase A（Untrusted 検査フェーズ: `scripts/verify-dependabot-pr-sandbox.sh`）**:
  - ホスト側ではコードを実行せず、`git diff` で `pnpm-lock.yaml` に新規の `hasInstallScript: true` が増えていないか、`worker/requirements*.txt` に未固定行が無いかを機械的に検査する。
  - ビルド・型チェック・単体テスト・`cdk synth`、およびメジャー更新でテストが落ちた際の AI（Claude Code）による自動マイグレーション修正は、すべて `agent-sandbox`（Docker + **gVisor `runsc` ランタイム**、AWS 鍵・SSH 鍵マウントなし、自宅 LAN 宛て通信遮断、`~/ops/agent-sandbox.md`）内で実行する。
- **Phase B（Trusted デプロイ・検証フェーズ: `process-dependabot-prs` skill）**:
  - Phase A と GitHub Actions CI の両方を通過した PR のみをホスト側でマージ・デプロイする。
  - CDK 更新時はマージ前に `cdk diff` を確認し、DynamoDB テーブルや S3 バケット等のステートフルリソースに `requires replacement` が出ている場合は自動マージを中止して人間へエスカレーションする。
  - マージ後のデプロイは `deploy-sattori` skill の順序制約（① `worker/` 変更時は ECR push & `eu-north-1` レプリカ到着確認 → ② `cdk deploy --all --require-approval never` → ③ `sattori-home-worker` 再起動）を厳守する。
  - メジャーアップデートや `@aws-sdk/*`・`aws-cdk-lib`・`worker/requirements-docker.txt` の更新時は、ローカル Docker 録画検証（`verify-recording-locally` skill）または本番 E2E 録画検証（`verify-recording-in-production` skill）を1本実行し、失敗時は直ちに `git revert` と再デプロイで自動ロールバックする。

## 根拠

- gVisor（`runsc`）と LAN 遮断・クレデンシャル非マウントを組み合わせることで、万一悪性パッケージがテスト中に発火しても、窃取できるホスト認証情報が存在せず、自宅 LAN への横展開もカーネルエスケープも遮断できる。
- 定型手順を `.claude/skills/process-dependabot-prs/SKILL.md` と `scripts/verify-dependabot-pr-sandbox.sh` に集約することで、定期実行エージェントも対話セッションのエージェントも同じ安全基準で PR を処理できる。

## 採らなかった選択肢

- **GitHub Actions 上だけでマージと AWS 本番デプロイまで完結させる**:
  GitHub Actions に AWS 本番の管理者権限（IAM ロール）や自宅ワーカー（`sattori-home-worker`）の再起動経路を持たせる必要があり、またローカル Docker 録画検証（タイトル資産キャッシュや GPU クォータ状況の判断）も行えないため採らなかった。
- **ホスト上で直接 PR ブランチを checkout してテストする**:
  クールダウン期間だけではテスト実行時の任意コード実行リスクをゼロにできないため採らなかった。

## 影響範囲

- `scripts/verify-dependabot-pr-sandbox.sh`
- `.claude/skills/process-dependabot-prs/SKILL.md`
