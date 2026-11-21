#!/usr/bin/env bash
# .gitleaks.toml と scripts/check-public-mirror.sh のルールの陽性(止まる)・陰性(通る)テスト。Issue #395。
#
#   scripts/test-public-mirror-rules.sh
#
# 違反の見本をこのファイルに値のまま書くと、このファイル自体が検査に引っかかるため、
# 一時ディレクトリへ実行時に組み立てて書き出す(値は文字列連結で分割しておく)。
set -uo pipefail

root="$(git rev-parse --show-toplevel)"
check="$root/scripts/check-public-mirror.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
export SATTORI_AWS_ACCOUNT_ID="987654321098" # テスト用の架空ID(本番値ではない)
export REQUIRE_ACCOUNT_ID=1
fail=0

# run <名前> <期待: block|pass> <ファイル名> <内容>
run() {
  local name="$1" expect="$2" file="$3" content="$4" dir
  dir="$(mktemp -d -p "$work")"
  mkdir -p "$dir/$(dirname "$file")"
  printf '%s\n' "$content" > "$dir/$file"
  if "$check" --tree "$dir" >/dev/null 2>&1; then got=pass; else got=block; fi
  if [ "$got" = "$expect" ]; then
    echo "ok   $name ($expect)"
  else
    echo "FAIL $name: 期待=$expect 実際=$got"; fail=1
  fi
}

d="."
# --- 陽性: わざと入れた違反が止まる
run "本番アカウントID(裸の12桁)" block a.md "bucket: x-${SATTORI_AWS_ACCOUNT_ID}-y"
run "ECR URL"                     block a.md "image: 555566667777${d}dkr${d}ecr${d}eu-south-2${d}amazonaws${d}com/worker"
run "S3バケット名(ID入り)"        block a.md "sattori-uploads-555566667777-eu-south-2"
run "ARN(実アカウント)"           block a.md "arn:aws:iam::555566667777:role/x"
run "EC2インスタンスID"           block a.md "instance i-0a1b2c3d4e5f60718 stopped"
run "AMI ID"                      block a.md "ami-0a1b2c3d4e5f60718"
run "SG ID"                       block a.md "sg-0a1b2c3d4e5f60718"
run "VPC ID"                      block a.md "vpc-0a1b2c3d"
run "サブネットID"                block a.md "subnet-0a1b2c3d4e5f60718"
run "ENI ID"                      block a.md "eni-0a1b2c3d4e5f60718"
run "スナップショットID"          block a.md "snap-0a1b2c3d4e5f60718"
run "ボリュームID"                block a.md "vol-0a1b2c3d4e5f60718"
run "スポットリクエストID"        block a.md "request sir-4rfqn43k"
run "キーペアID"                  block a.md "key-0a1b2c3d4e5f60718"
run "グローバルIP"                block a.md "home: 5${d}6${d}7${d}8 is up"
run "グローバルIP(行末ピリオド)" block a.md "ssh to 5${d}6${d}7${d}8."
run "jobId入り.rpy"               block a.md "file 3f2b8c1e-9d4a-4e7b-8a15-6c0d2e9f1a47.rpy"
run "jobs/<uuid>"                 block a.md "s3://b/jobs/3f2b8c1e-9d4a-4e7b-8a15-6c0d2e9f1a47/out.mp4"
run "replays/<uuid>"              block a.md "replays/3f2b8c1e-9d4a-4e7b-8a15-6c0d2e9f1a47"
run "プライベートIP(既存)"        block a.md "nas 192${d}168${d}1${d}5"
run "通常名の.rpy(fixture)"        pass th06_ud0001.rpy "x"
run "禁止拡張子 .exe"             block game.exe "x"
run "禁止パス worker/assets"      block worker/assets/a.txt "x"

# --- 陰性: ダミー値・テスト用値・無害な文字列は通る
run "ARNのプレースホルダ"         pass a.md "arn:aws:iam::123456789012:role/x"
run "ドキュメント慣用のダミーi-"  pass a.md "i-0123456789abcdef0"
run "ドキュメント慣用のダミーami" pass a.md "ami-0123456789abcdef0"
run "全桁0のsg"                   pass a.md "sg-00000000"
run "テスト用の固定UUID"          pass a.md "jobs/00000000-0000-4000-8000-000000000001/out.mp4"
run "全桁0のUUID.rpy"             pass a.md "00000000-0000-0000-0000-000000000000.rpy"
run "UUID単体(jobIdと無関係の文脈)" pass a.md "request id 3f2b8c1e-9d4a-4e7b-8a15-6c0d2e9f1a47"
run "ドキュメント用IP"            pass a.md "192${d}0${d}2${d}10 and 198${d}51${d}100${d}7 and 203${d}0${d}113${d}9"
run "ループバック・0.0.0.0"       pass a.md "127${d}0${d}0${d}1 0${d}0${d}0${d}0"
run "公開DNS"                     pass a.md "8${d}8${d}8${d}8 1${d}1${d}1${d}1"
run "バージョン番号"              pass a.md "node 24${d}1${d}2 and v1${d}2${d}3${d}4-beta and 3${d}12${d}4${d}1${d}7"
run "CIDR(VPC設計)"               pass a.md "cidr: 10${d}0${d}0${d}0/16"
run "12桁だが無関係の数値"        pass a.md "frameCount 123456789012345 id 555566667777"
run "UAのバージョン"              pass a.md "Chrome/128${d}0${d}0${d}0 Safari/537${d}36"
run "version行の4つ組"            pass a.md "{ version: \"2${d}3${d}0${d}3\" }"
run "ふつうの.ts"                 pass a.ts "export const x = 1;"

[ "$fail" = 0 ] && echo "全テスト通過" || { echo "失敗あり"; exit 1; }
