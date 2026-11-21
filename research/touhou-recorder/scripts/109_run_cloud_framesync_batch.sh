#!/usr/bin/env bash
# フェーズ109: フレーム同期キャプチャ(--frame-sync)を複数ジョブ連続で実行するバッチスクリプト。
# クラウド(CPU / GPU)およびローカル検証用。
#
# Usage:
#   scripts/109_run_cloud_framesync_batch.sh <out_dir> <mode=cpu|gpu> <game> <label> <replay> [...]
#
# 環境変数:
#   EXTRA_ARGS          scripts/25 への追加引数(例: "--record-seconds 40")
#   USE_GPU_ENCODE=1    --gpu-encode (NVENC)を有効化
#   LOAD_WORKERS=N      指定時、録画中に scripts/109_cpu_load.py --workers N をバックグラウンド実行
#   TIMEOUT_SEC         既定7200
#   LP_NUM_THREADS      CPUモード時のllvmpipeスレッド数(既定 nproc)
#
# 出力: <out_dir>/<label>.{mp4,log,modlog.txt,mpstat.txt,(gpu.txt),done}。完了で ALL_DONE。
set -uo pipefail
OUT="$1"; mode="$2"; shift 2
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"
mkdir -p "$OUT"
rm -f "$OUT/ALL_DONE"
export TIMEOUT_SEC=${TIMEOUT_SEC:-7200}

if [ "${SETUP_PULSE:-0}" = "1" ]; then
  systemctl --user mask --now pulseaudio.socket pulseaudio.service >/dev/null 2>&1 || true
  pgrep -x pulseaudio >/dev/null || { rm -rf "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/pulse"; setsid nohup pulseaudio --exit-idle-time=-1 >/dev/null 2>&1 & sleep 3; }
fi

if [ "$mode" = "cpu" ]; then
  export GALLIUM_DRIVER=llvmpipe LIBGL_ALWAYS_SOFTWARE=1
  export LP_NUM_THREADS=${LP_NUM_THREADS:-$(nproc)}
elif [ "$mode" != "gpu" ]; then
  echo "unknown mode: $mode" >&2
  exit 2
fi

while [ $# -ge 3 ]; do
  game=$1 label=$2 replay=$3; shift 3

  if [ "$mode" = "gpu" ]; then
    # 1枚のvGPU上で複数のXorgを起動しない(reports/89)。毎回既存のGPU描画面を停止する。
    for d in $(ps -eo args | grep -o "Xorg :[0-9]* -config" | grep -o ":[0-9]*" | sort -u); do
      scripts/78_start_gpu_display.sh --display "$d" --stop 2>/dev/null || true
      sudo rm -f "/tmp/.X${d#:}-lock" "/tmp/.X11-unix/X${d#:}"
    done
  fi

  args=(--game "$game" --frame-sync --max-attempts 1 --max-duplicate-rate 100
        --output "$OUT/$label.mp4")
  [ "$replay" != "-" ] && args+=(--replay "$replay")
  if [ "$mode" = "cpu" ]; then
    [ "$game" = "th15" ] && args+=(--cpu-display)
  else
    [ "$game" = "th12" ] && args+=(--gpu-display)
    [ "${USE_GPU_ENCODE:-0}" = "1" ] && args+=(--gpu-encode)
  fi
  case "$game" in
    th128|th20) args+=(--thprac) ;;
  esac

  echo "=== $(date -Is) START $label game=$game replay=$replay mode=$mode nproc=$(nproc) gpu_encode=${USE_GPU_ENCODE:-0} load=${LOAD_WORKERS:-0}"
  MP=; if command -v mpstat >/dev/null; then mpstat 1 > "$OUT/$label.mpstat.txt" 2>&1 & MP=$!; fi
  NV=; if [ "$mode" = "gpu" ] && command -v nvidia-smi >/dev/null; then nvidia-smi dmon -s u -d 1 > "$OUT/$label.gpu.txt" 2>&1 & NV=$!; fi
  LD=; if [ "${LOAD_WORKERS:-0}" -gt 0 ]; then python3 scripts/109_cpu_load.py --workers "$LOAD_WORKERS" > "$OUT/$label.load.log" 2>&1 & LD=$!; fi

  start=$(date +%s)
  # shellcheck disable=SC2086
  python3 scripts/25_record_replay_e2e_multigame.py "${args[@]}" ${EXTRA_ARGS:-} > "$OUT/$label.log" 2>&1
  rc=$?
  elapsed=$(( $(date +%s) - start ))

  [ -n "$LD" ] && kill "$LD" 2>/dev/null && wait "$LD" 2>/dev/null || true
  [ -n "$MP" ] && kill "$MP" 2>/dev/null || true
  [ -n "$NV" ] && kill "$NV" 2>/dev/null || true

  cp "instances/$game-multigame-recording-test/${game}_autoplay.log" "$OUT/$label.modlog.txt" 2>/dev/null || true
  python3 scripts/105_frame_sync_summary.py "$OUT/$label.modlog.txt" 3600 > "$OUT/$label.summary.txt" 2>/dev/null || true
  echo "rc=$rc elapsed=$elapsed" > "$OUT/$label.done"
  echo "=== $(date -Is) END $label rc=$rc elapsed=${elapsed}s"
done
[ "${SKIP_ALL_DONE:-0}" != "1" ] && touch "$OUT/ALL_DONE"
echo ALL_DONE
