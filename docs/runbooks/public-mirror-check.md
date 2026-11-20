# 公開ミラーの機密情報検査

main への push のたびに `.github/workflows/mirror-public.yml` が全履歴を検査してから公開リポジトリ
`hakatashi/sattori` へ force push する。同じ検査をローカルでも実行できる（Issue #395）。

```bash
scripts/check-public-mirror.sh                 # 全履歴（gitleaks が必要。GITLEAKS_BIN で指定可）
scripts/check-public-mirror.sh --tree <dir>    # 任意のツリー（#396 の取り込み前の検査など）
scripts/test-public-mirror-rules.sh            # ルール自体の陽性・陰性テスト
```

## 構成

- 禁止パス: `worker/games|prefixes|assets/` と wav・mp3・ogg・mp4・exe・dll・dat・zip・pem
  （`scripts/check-public-mirror.sh` の `FORBIDDEN_REGEX`）。`.rpy` は fixture があるため拡張子では禁止せず、
  jobId（認可の秘密値、decisions/0004）を名前に持つものを gitleaks のルールで止める。
- `.gitleaks.toml`: 標準ルール + ARN・ECR URL・AWS リソースID・S3 バケット名・グローバルIPv4・jobId・プライベートIP。
- **本番アカウントID（裸の12桁）は値をリポジトリに書けない**ため、環境変数 `SATTORI_AWS_ACCOUNT_ID` から
  実行時にルールを生成して照合する。CI ではリポジトリ secret `SATTORI_AWS_ACCOUNT_ID` を使い、未登録なら失敗する。
  ローカルでは `scripts/sattori-env.sh` が自動で解決する。
- `.gitleaksignore`: 履歴上の既知の検出。足すときはユーザーの判断を得ること。

## 注意

- `color.ui=always` などのグローバル git 設定は gitleaks の履歴解析を壊し、「0 commits scanned」で素通りする。
  スクリプトは `GIT_CONFIG_GLOBAL=/dev/null` で回避している。素の `gitleaks detect` を手で叩くときは
  「N commits scanned」の N が0でないことを確認すること。
- ルールを足したら `scripts/test-public-mirror-rules.sh` に陽性・陰性のケースを足す。違反の見本は
  このスクリプトの中でも値を分割して組み立てている（自分自身が検査に引っかかるため）。
