#!/usr/bin/env bash
# th06nc(東方紅魔郷: New Classic)の起動実験用ヘルパー(フェーズ78)。
#
# Xvfb :91 + openbox を起動し、instances/th06nc-test でth06nc.exeを実行する。
# 実行後は必ずwineserver/winedeviceを後片付けする(AGENTS.md / reports/55)。
#
# Usage: scripts/78_run_th06nc.sh [--timeout SEC] [--] [追加のwine引数...]
# 例:    scripts/78_run_th06nc.sh --timeout 60
#        scripts/78_run_th06nc.sh --timeout 90 injector.exe th06nc.exe th06nc_hook.dll

set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PREFIX="$REPO/prefixes/th06nc-wined3d-gl"
INSTANCE="$REPO/instances/th06nc-test"
# 既定は scripts/78_start_gpu_display.sh が用意するGPU描画面(:88)。
# llvmpipeとの比較検証をしたい場合のみ GPU_DISPLAY=:91 のようにXvfbを指定する。
DISPLAY_NUM="${GPU_DISPLAY:-:88}"
# 1080p(1920x1080)のウィンドウ+装飾が収まるサイズ。720p検証時もこのままでよい。
XVFB_SCREEN="${XVFB_SCREEN:-2200x1400x24}"
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
  CMD=(th06nc.exe)
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

if ! DISPLAY="$DISPLAY_NUM" timeout 5 xdpyinfo >/dev/null 2>&1; then
  # th06ncはllvmpipeでは60fpsが出ない(reports/78)。GPU描画面を用意する。
  "$REPO/scripts/78_start_gpu_display.sh" --display "$DISPLAY_NUM" --screen "${XVFB_SCREEN%x*}" || exit 1
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
