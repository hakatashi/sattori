#!/usr/bin/env bash
# th06ncのMOD動作を切り分けるための「起動 + 定期スクリーンショット」ヘルパー(フェーズ78)。
#
# GPU描画面(scripts/78_start_gpu_display.sh、既定 :92)でinjector経由でMODを注入して
# th06nc.exeを起動し、指定した秒数で画面をキャプチャする。終了時はwineを必ず後片付けする
# (AGENTS.md / reports/55)。
#
# Usage:
#   scripts/78_th06nc_diag.sh --tag <名前> --shots "5,10,20,30" [--run-sec 40] [--env KEY=VAL]...
#
# 例: scripts/78_th06nc_diag.sh --tag menu --shots "6,9,12,15,20" --env TH06NC_SEQ=enter

set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PREFIX="$REPO/prefixes/th06nc-wined3d-gl"
INSTANCE="$REPO/instances/th06nc-test"
OUTDIR="$REPO/runs/th06nc_verification"
DISPLAY_NUM="${GPU_DISPLAY:-:88}"
SCREEN="${GPU_SCREEN:-2200x1400}"
TAG="diag"
SHOTS="10,20,30"
RUN_SEC=45
ENVS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag) TAG="$2"; shift 2 ;;
    --shots) SHOTS="$2"; shift 2 ;;
    --run-sec) RUN_SEC="$2"; shift 2 ;;
    --env) ENVS+=("$2"); shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

mkdir -p "$OUTDIR"

cleanup() {
  echo "--- cleanup ---" >&2
  local pids
  pids=$(ps -eo pid,args | grep '[t]h06nc\.exe' | awk '{print $1}')
  for p in $pids; do kill -9 "$p" 2>/dev/null; done
  WINEPREFIX="$PREFIX" timeout 30 wineserver -k 2>/dev/null
  for pid in $(ps -eo pid,comm | grep -E 'wine(server)?64?' | awk '{print $1}'); do
    if grep -qz "WINEPREFIX=$PREFIX" "/proc/$pid/environ" 2>/dev/null; then
      kill -9 "$pid" 2>/dev/null
    fi
  done
}
trap cleanup EXIT

"$REPO/scripts/78_start_gpu_display.sh" --display "$DISPLAY_NUM" --screen "$SCREEN" || exit 1

rm -f "$INSTANCE/th06nc_autoplay.log" "$INSTANCE/th06c_steam_stub.log"

(
  cd "$INSTANCE" || exit 1
  for e in "${ENVS[@]:-}"; do [[ -n "$e" ]] && export "${e?}"; done
  WINEPREFIX="$PREFIX" DISPLAY="$DISPLAY_NUM" LANG=ja_JP.UTF-8 \
    timeout "$RUN_SEC" wine injector64.exe th06nc.exe th06nc_hook.dll \
    > "/tmp/th06nc_diag_$TAG.log" 2>&1
) &
RUNNER=$!

export DISPLAY="$DISPLAY_NUM"
prev=0
IFS=',' read -ra TIMES <<< "$SHOTS"
for t in "${TIMES[@]}"; do
  sleep "$((t - prev))"
  prev=$t
  wid=$(xdotool search --name "New Classic" 2>/dev/null | head -1)
  if [[ -z "$wid" ]]; then
    echo "t=${t}s: ウィンドウ未検出" >&2
    continue
  fi
  info=$(xwininfo -id "$wid" | grep -E "Absolute upper-left X|Absolute upper-left Y|Width:|Height:" | awk '{print $NF}' | tr '\n' ' ')
  set -- $info
  ffmpeg -loglevel error -f x11grab -video_size "${3}x${4}" -i "${DISPLAY_NUM}.0+${1},${2}" \
      -frames:v 1 -y "$OUTDIR/78_${TAG}_t${t}.png" 2>/dev/null
  echo "t=${t}s: $OUTDIR/78_${TAG}_t${t}.png (${3}x${4} at ${1},${2})" >&2
done

wait $RUNNER 2>/dev/null
echo "=== th06nc_autoplay.log ===" >&2
cat "$INSTANCE/th06nc_autoplay.log" 2>/dev/null >&2
