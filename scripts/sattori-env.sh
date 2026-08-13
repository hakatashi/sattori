#!/usr/bin/env bash
# Sattori のデプロイ系 Skill が共有する環境値を解決する。
#
# AWS アカウントID・S3 バケット名はリポジトリにコミットしないため、AWS から都度解決し、
# gitignore 済みの `.agents/sattori-env.cache` にキャッシュする。
#
#   source scripts/sattori-env.sh
#   echo "$SATTORI_ECR_REPO"
#
# 解決される変数:
#   SATTORI_REGION               本体スタックのリージョン(既定 eu-south-2)
#   SATTORI_AWS_ACCOUNT_ID       sts get-caller-identity
#   SATTORI_TITLE_ASSETS_BUCKET  SattoriStack の CfnOutput TitleAssetsBucketName
#   SATTORI_ECR_REPO             ワーカーイメージの ECR リポジトリURI
#
# いずれも呼び出し側で環境変数として先に与えれば、そちらが優先される
# (AWS CLI を叩けない環境向け)。キャッシュを作り直したいときは
# `.agents/sattori-env.cache` を消す。
#
# 注: `set -e` は付けないこと。source された側のシェルに波及する。

SATTORI_REGION="${SATTORI_REGION:-eu-south-2}"
_sattori_root="$(git rev-parse --show-toplevel)"
_sattori_cache="${_sattori_root}/.agents/sattori-env.cache"

if [ -f "$_sattori_cache" ]; then
  # shellcheck disable=SC1090
  . "$_sattori_cache"
fi

if [ -z "${SATTORI_AWS_ACCOUNT_ID:-}" ]; then
  SATTORI_AWS_ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
fi

if [ -z "${SATTORI_TITLE_ASSETS_BUCKET:-}" ]; then
  SATTORI_TITLE_ASSETS_BUCKET="$(aws cloudformation describe-stacks \
    --region "$SATTORI_REGION" --stack-name SattoriStack \
    --query "Stacks[0].Outputs[?OutputKey=='TitleAssetsBucketName'].OutputValue" \
    --output text)"
fi

SATTORI_ECR_REPO="${SATTORI_AWS_ACCOUNT_ID}.dkr.ecr.${SATTORI_REGION}.amazonaws.com/sattori-worker"

mkdir -p "$(dirname "$_sattori_cache")"
cat > "$_sattori_cache" <<EOF
SATTORI_REGION=${SATTORI_REGION}
SATTORI_AWS_ACCOUNT_ID=${SATTORI_AWS_ACCOUNT_ID}
SATTORI_TITLE_ASSETS_BUCKET=${SATTORI_TITLE_ASSETS_BUCKET}
EOF

export SATTORI_REGION SATTORI_AWS_ACCOUNT_ID SATTORI_TITLE_ASSETS_BUCKET SATTORI_ECR_REPO

unset _sattori_root _sattori_cache
