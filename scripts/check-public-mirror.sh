#!/usr/bin/env bash
# 公開ミラー(hakatashi/sattori)へ出してよいかの検査。CI(mirror-public.yml)とローカルで同じものを使う。
#
#   scripts/check-public-mirror.sh                # このリポジトリの全履歴を検査
#   scripts/check-public-mirror.sh --tree <dir>   # 任意のディレクトリ(取り込み前のツリー等、#396)を検査
#
# 1. 禁止パス(ゲームの実データ・バイナリ・鍵。.rpy は fixture があるため拡張子では禁止せず、jobId 名のものを gitleaks で止める)が無いか
# 2. gitleaks(.gitleaks.toml + 実アカウントIDの照合)
#
# 実アカウントIDは環境変数 SATTORI_AWS_ACCOUNT_ID から取る。未設定なら
# scripts/sattori-env.sh(AWS CLI経由)で解決を試み、それも失敗したら、その照合だけ省いて警告する。
# CI では strict(REQUIRE_ACCOUNT_ID=1)にして、値が無ければ失敗させる。
# gitleaks が PATH に無ければ GITLEAKS_BIN で指定する。
set -euo pipefail
# グローバルgit設定(color.ui=always等)がgitleaksのgit log解析を壊すため、無効化する
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null

root="$(git rev-parse --show-toplevel)"
gitleaks="${GITLEAKS_BIN:-gitleaks}"
mode=history
tree=""
if [ "${1:-}" = "--tree" ]; then
  mode=tree
  tree="${2:?--tree にはディレクトリを指定すること}"
fi

# 禁止パス。worker/assets/ は終了検知テンプレートの保護のため禁止のまま(扱いは #395 で要確認)。
FORBIDDEN_REGEX='(^worker/games/|^worker/prefixes/|^worker/assets/|\.(wav|mp3|ogg|mp4|exe|dll|dat|zip|pem)$)'

echo "== 禁止パスの検査"
if [ "$mode" = history ]; then
  paths=$(git -C "$root" log --all --diff-filter=A --name-only --pretty=format: | grep -v '^$' || true)
else
  paths=$(cd "$tree" && find . -type f -not -path './.git/*' | sed 's|^\./||')
fi
matches=$(printf '%s\n' "$paths" | grep -iE "$FORBIDDEN_REGEX" | sort -u || true)
if [ -n "$matches" ]; then
  echo "::error::公開してはいけないパスが含まれています:"
  echo "$matches"
  exit 1
fi

echo "== gitleaks の設定を組み立て"
account_id="${SATTORI_AWS_ACCOUNT_ID:-}"
if [ -z "$account_id" ] && [ "${REQUIRE_ACCOUNT_ID:-0}" != 1 ] && [ -f "$root/scripts/sattori-env.sh" ]; then
  # shellcheck disable=SC1091
  account_id="$( . "$root/scripts/sattori-env.sh" >/dev/null 2>&1; echo "${SATTORI_AWS_ACCOUNT_ID:-}" )" || true
fi
config="$(mktemp --suffix=.toml)"
trap 'rm -f "$config"' EXIT
cp "$root/.gitleaks.toml" "$config"
if [[ "$account_id" =~ ^[0-9]{12}$ ]]; then
  cat >> "$config" <<TOML

[[rules]]
id = "real-aws-account-id"
description = "本番のAWSアカウントID(裸の12桁)"
regex = '''(?:^|[^0-9])${account_id}(?:\$|[^0-9])'''
tags = ["aws", "account-id"]
TOML
else
  if [ "${REQUIRE_ACCOUNT_ID:-0}" = 1 ]; then
    echo "::error::SATTORI_AWS_ACCOUNT_ID が未設定です(REQUIRE_ACCOUNT_ID=1)"
    exit 1
  fi
  echo "警告: 実アカウントIDが解決できないため、その照合を省略します" >&2
fi

echo "== gitleaks"
if [ "$mode" = history ]; then
  "$gitleaks" detect --source "$root" --config "$config" --no-banner --redact
else
  "$gitleaks" dir "$tree" --config "$config" --no-banner --redact
fi
echo "OK: 公開してよい状態です"
