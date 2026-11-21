#!/usr/bin/env bash
# th06c(東方紅魔郷: Classic)の起動実験用ヘルパー(フェーズ74)。
#
# Xvfb :90 + openbox を起動し、instances/th06c-test でth06c.exeを実行する。
# 実行後は必ずwineserver/winedeviceを後片付けする(AGENTS.md / reports/55)。
#
# Usage: scripts/74_run_th06c.sh [--timeout SEC] [--] [追加のwine引数...]
# 例:    scripts/74_run_th06c.sh --timeout 60
#        scripts/74_run_th06c.sh --timeout 90 injector.exe th06c.exe th06c_hook.dll

set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PREFIX="$REPO/prefixes/th06c-wined3d-gl"
INSTANCE="$REPO/instances/th06c-test"
DISPLAY_NUM=":90"
XVFB_SCREEN="1400x1100x24"
TIMEOUT=60
# injector経由の場合、injector.exe自体はDLL注入後すぐ終了するので、
# ゲーム本体を動かし続けるために追加で待つ秒数。
WAIT_AFTER=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --timeout) TIMEOUT="$2"; shift 2 ;;
    --wait) WAIT_AFTER="$2"; shift 2 ;;
    --) shift; break ;;
    *) break ;;
  esac
done

CMD=("$@")
if [[ ${#CMD[@]} -eq 0 ]]; then
  CMD=(th06c.exe)
fi

cleanup() {
  local status=$?
  echo "--- cleanup ---" >&2
  WINEPREFIX="$PREFIX" timeout 30 wineserver -k 2>/dev/null
  # wineserver -k で落ちない場合に備え、当該WINEPREFIX配下のプロセスを直接落とす
  for pid in $(pgrep -f 'wine' 2>/dev/null); do
    if grep -qz "WINEPREFIX=$PREFIX" "/proc/$pid/environ" 2>/dev/null; then
      echo "SIGKILL $pid" >&2
      kill -9 "$pid" 2>/dev/null
    fi
  done
  return $status
}
trap cleanup EXIT

if ! DISPLAY="$DISPLAY_NUM" xdpyinfo >/dev/null 2>&1; then
  echo "Xvfb $DISPLAY_NUM を起動します" >&2
  Xvfb "$DISPLAY_NUM" -screen 0 "$XVFB_SCREEN" >/tmp/xvfb90.log 2>&1 &
  sleep 2
  DISPLAY="$DISPLAY_NUM" openbox --sm-disable >/tmp/openbox90.log 2>&1 &
  sleep 2
fi

cd "$INSTANCE" || exit 1
echo "実行: wine ${CMD[*]} (timeout ${TIMEOUT}s)" >&2
WINEPREFIX="$PREFIX" DISPLAY="$DISPLAY_NUM" LANG=ja_JP.UTF-8 \
  timeout "$TIMEOUT" wine "${CMD[@]}"
echo "exit=$?" >&2

if [[ "$WAIT_AFTER" -gt 0 ]]; then
  echo "ゲーム本体の動作を ${WAIT_AFTER}s 待ちます" >&2
  sleep "$WAIT_AFTER"
fi
