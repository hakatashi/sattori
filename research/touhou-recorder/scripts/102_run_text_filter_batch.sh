#!/usr/bin/env bash
# フェーズ102: 文字の縮小フィルタ(D3DX_AREA_FILTER=1、reports/101)をth10〜th15に適用した録画を、
# recorder/(scripts/25)経由で順に行う。ローカル・AWSの両方で使う。
#
# Usage: scripts/102_run_text_filter_batch.sh <out_dir> <game> <label> <replay> <mode> <hz> <secs> [...6個ずつ繰り返し]
#   mode: area(D3DX_AREA_FILTER=1) / builtin(現行、フィルタなし)
#   hz:   60=等倍、30=1/2倍速(FPS_LIMIT_TARGET_HZ=30 SPEED_HACK_MULTIPLIER=0.5)、20=1/3倍速
#   secs: full=フル尺、数値=--record-seconds
# 追加のscripts/25引数は環境変数 EXTRA_ARGS で渡す。D3DX_LOAD_PROBE=1 を付けると転送の記録をMODログに残す。
# 出力: <out_dir>/<label>.{mp4,log,modlog.txt,mpstat.txt,done}。全体の終了で <out_dir>/ALL_DONE。
# recorder は try/finally で wineserver を片付ける(reports/55)。このスクリプトは中断されても次へ進まない。
set -uo pipefail
OUT="$1"; shift
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"
mkdir -p "$OUT"; rm -f "$OUT/ALL_DONE"
export TIMEOUT_SEC=${TIMEOUT_SEC:-7200}
if [ "${SETUP_PULSE:-0}" = 1 ]; then  # AWS(linger下)ではsystemdのソケットと衝突するので手動起動に一本化(reports/91)
  systemctl --user mask --now pulseaudio.socket pulseaudio.service >/dev/null 2>&1
  pgrep -x pulseaudio >/dev/null || { rm -rf "$XDG_RUNTIME_DIR/pulse"; setsid nohup pulseaudio --exit-idle-time=-1 >/dev/null 2>&1 & sleep 3; }
  pactl list short sources | grep -q auto_null.monitor || { echo "ERROR: auto_null.monitorがありません"; exit 1; }
  export GALLIUM_DRIVER=llvmpipe LIBGL_ALWAYS_SOFTWARE=1
  export LP_NUM_THREADS=${LP_NUM_THREADS:-$(nproc)}
fi
while [ $# -ge 6 ]; do
  game=$1 label=$2 replay=$3 mode=$4 hz=$5 secs=$6; shift 6
  envs=()
  case $mode in
    area) envs+=(D3DX_AREA_FILTER=1) ;;
    builtin) ;;
    *) echo "unknown mode $mode"; exit 2 ;;
  esac
  case $hz in
    60) ;;
    30) envs+=(FPS_LIMIT_TARGET_HZ=30 SPEED_HACK_MULTIPLIER=0.5) ;;
    20) envs+=(FPS_LIMIT_TARGET_HZ=20 SPEED_HACK_MULTIPLIER=0.3333333) ;;
    *) echo "unknown hz $hz"; exit 2 ;;
  esac
  case $game in
    th15) title_args=(--cpu-display) ;;  # 既定のGPU描画面を使わない
    th128|th20) title_args=(--thprac) ;;
    *) title_args=() ;;
  esac
  args=(--game "$game" --replay "$replay" --output "$OUT/$label.mp4" --max-attempts 1)
  [ "$secs" != full ] && args+=(--record-seconds "$secs")
  echo "=== $(date -Is) START $label game=$game replay=$replay mode=$mode hz=$hz secs=$secs nproc=$(nproc)"
  MP=; if command -v mpstat >/dev/null; then mpstat 1 > "$OUT/$label.mpstat.txt" 2>&1 & MP=$!; fi
  start=$(date +%s)
  env "${envs[@]}" python3 scripts/25_record_replay_e2e_multigame.py "${args[@]}" "${title_args[@]}" \
    ${EXTRA_ARGS:-} > "$OUT/$label.log" 2>&1
  rc=$?
  [ -n "$MP" ] && kill $MP 2>/dev/null
  cp "instances/$game-multigame-recording-test/${game}_autoplay.log" "$OUT/$label.modlog.txt" 2>/dev/null
  echo "rc=$rc elapsed=$(( $(date +%s) - start ))" > "$OUT/$label.done"
  echo "=== $(date -Is) END $label rc=$rc elapsed=$(( $(date +%s) - start ))s"
done
touch "$OUT/ALL_DONE"
