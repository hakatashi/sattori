#!/usr/bin/env bash
#
# verify-dependabot-pr-sandbox.sh
# Dependabot PR を gVisor (runsc) 隔離サンドボックス内で安全に検査・ビルド・テストするスクリプト（Issue #341）。
# ホストの AWS 認証情報・SSH 鍵・GitHub トークンを一切マウントせず、自宅 LAN への通信も遮断した状態で
# ロックファイルの不審な変更チェックとビルド・テストを実行する
# （docs/decisions/0069-automated-dependabot-merge-deploy-with-gvisor-sandbox.md）。
#
# 使い方:
#   scripts/verify-dependabot-pr-sandbox.sh <PR番号> [--fix-with-claude]
#
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $0 <pr_number> [--fix-with-claude]" >&2
  exit 1
fi

PR_NUMBER="$1"
FIX_WITH_CLAUDE=false
if [ "${2:-}" = "--fix-with-claude" ]; then
  FIX_WITH_CLAUDE=true
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SANDBOX_IMAGE="agent-sandbox:latest"
SANDBOX_NET="agent-sandbox-net"
RESOLV_CONF="$HOME/agent-sandbox/resolv.conf"
GUIDELINES_FILE="$HOME/agent-sandbox/prompts/SANDBOX_GUIDELINES.md"

TEMP_DIR=$(mktemp -d /tmp/sattori-dependabot-pr-${PR_NUMBER}-XXXXXX)
trap 'rm -rf "$TEMP_DIR"' EXIT

echo "==> [Phase A] Preparing isolated worktree for PR #${PR_NUMBER} in ${TEMP_DIR}..."
git clone --quiet "$REPO_ROOT" "$TEMP_DIR/repo"
cd "$TEMP_DIR/repo"

# ホスト側で PR ブランチのみを fetch し、最新の main とマージした状態を検証する（コンテナへ渡す前に remote 情報を完全削除）
git remote set-url origin git@github.com:hakatashi/sattori-dev.git
git fetch --quiet origin "pull/${PR_NUMBER}/head:pr-${PR_NUMBER}" main:base-main
git checkout --quiet "pr-${PR_NUMBER}"
git merge --no-edit --quiet base-main
git remote remove origin

# cdk synth 用の context (cdk.json) が .gitignore 対象の場合に備え、ホストからコピーする（秘密値は含まない）
if [ -f "$REPO_ROOT/infra/cdk.json" ]; then
  cp "$REPO_ROOT/infra/cdk.json" "$TEMP_DIR/repo/infra/cdk.json"
fi

echo "==> [Phase A.1] Auditing lockfile diffs on host (no code execution)..."
# 1. pnpm-lock.yaml に新しい hasInstallScript: true が増えていないか検査
NEW_INSTALL_SCRIPTS=$(git diff base-main...HEAD -- pnpm-lock.yaml | grep -E '^\+.*hasInstallScript:\s*true' || true)
if [ -n "$NEW_INSTALL_SCRIPTS" ]; then
  echo "::error::PR #${PR_NUMBER} introduces new hasInstallScript: true in pnpm-lock.yaml!" >&2
  echo "$NEW_INSTALL_SCRIPTS" >&2
  exit 2
fi

# 2. worker/requirements*.txt に == 以外の未固定行が含まれていないか検査
UNPINNED_PY=$(grep -rnvE '^(#|-r |[a-zA-Z0-9_.-]+==|$)' worker/requirements*.txt || true)
if [ -n "$UNPINNED_PY" ]; then
  echo "::error::PR #${PR_NUMBER} contains unpinned Python dependencies in worker/requirements*.txt!" >&2
  echo "$UNPINNED_PY" >&2
  exit 2
fi

chmod -R ugo+rwX "$TEMP_DIR/repo"

echo "==> [Phase A.2] Running build, typecheck, test, and cdk synth inside gVisor (runsc) sandbox..."
set +e
docker run --rm \
  --runtime=runsc \
  --network "$SANDBOX_NET" \
  --cap-drop=ALL \
  --security-opt=no-new-privileges \
  --memory=8g \
  --cpus=6 \
  --pids-limit=2048 \
  -v "$RESOLV_CONF":/etc/resolv.conf:ro \
  -v "$TEMP_DIR/repo":/workspace \
  -w /workspace \
  "$SANDBOX_IMAGE" \
  bash -c '
    set -euo pipefail
    umask 0000
    trap "chmod -R a+rwX /workspace 2>/dev/null || true" EXIT
    export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
    git config --global --add safe.directory /workspace
    corepack enable --install-directory /home/agent/.local/bin
    if ! command -v rsync >/dev/null 2>&1; then
      cat << "EOF" > /home/agent/.local/bin/rsync
#!/usr/bin/env python3
import shutil, sys
args = [a for a in sys.argv[1:] if not a.startswith("-")]
shutil.copytree(args[-2].rstrip("/"), args[-1].rstrip("/"), dirs_exist_ok=True, ignore=shutil.ignore_patterns("replay"))
EOF
      chmod +x /home/agent/.local/bin/rsync
    fi
    pnpm check:docs
    pnpm install --frozen-lockfile
    pip3 install --user --break-system-packages --no-cache-dir -r worker/requirements-dev.txt
    pnpm exec turbo run build --concurrency=2
    pnpm exec turbo run typecheck --concurrency=2
    pnpm exec turbo run test --concurrency=2
    pnpm --filter @sattori/infra synth >/dev/null
  '
TEST_EXIT=$?
set -e

if [ "$TEST_EXIT" -ne 0 ]; then
  if [ "$FIX_WITH_CLAUDE" = true ]; then
    echo "==> [Phase A.3] Tests failed (exit $TEST_EXIT). Invoking sandboxed Claude Code to attempt migration fix..."
    docker run --rm \
      --runtime=runsc \
      --network "$SANDBOX_NET" \
      --cap-drop=ALL \
      --security-opt=no-new-privileges \
      --memory=8g \
      --cpus=6 \
      --pids-limit=400 \
      -v "$RESOLV_CONF":/etc/resolv.conf:ro \
      -v "$TEMP_DIR/repo":/workspace \
      -v claude-sandbox-auth:/home/agent/.claude \
      -v "$GUIDELINES_FILE":/home/agent/.claude/CLAUDE.md:ro \
      -w /workspace \
      "$SANDBOX_IMAGE" \
      claude -p "このブランチはDependabotによる依存パッケージ更新PRですが、ビルド・型チェック・テストのいずれかが失敗しています。破壊的変更に合わせて最小限のコード修正を行い、pnpm check:docs && pnpm build && pnpm typecheck && pnpm --filter '!@sattori/worker' test && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm --filter @sattori/infra synth がすべて通る状態にしてください。package.jsonのバージョン指定やロックファイル自体はダウングレードしないでください。"

    if [ -n "$(git status --porcelain)" ]; then
      PATCH_OUT="/tmp/sattori-pr-${PR_NUMBER}-fix.patch"
      git diff > "$PATCH_OUT"
      echo "==> [Phase A.3] Migration fix generated at: $PATCH_OUT"
      exit 10
    fi
  fi
  echo "::error::Sandbox verification failed for PR #${PR_NUMBER} (exit $TEST_EXIT)." >&2
  exit "$TEST_EXIT"
fi

echo "==> [Phase A] PR #${PR_NUMBER} passed all gVisor sandbox checks!"
