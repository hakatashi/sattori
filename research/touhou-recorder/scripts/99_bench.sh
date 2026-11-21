#!/bin/bash
# CPU描画(Xvfb+wined3d+llvmpipe)の処理能力を比べるベンチマーク(reports/99)。
#
# 倍速フック(SPEED_HACK_MULTIPLIER)で上限を外し、描画が許す限り速くリプレイを回す。
# FpsMonitorのHzがそのまま「1秒に描けるフレーム数」になり、リプレイ自体も速く進むので
# 重い場面へ早く着く。録画は付随(キャプチャは30fpsに落として負荷を減らす)で、品質は見ない。
#
# 使い方: scripts/99_bench.sh <th15|th20> <ラベル> <リプレイ> [cpuset]
#   追加の環境変数(LP_*, GALLIUM_*, D3D9_*, WINEDLLOVERRIDES等)はそのままゲームへ渡る。
#   BENCH_MULT(既定4)で倍率を変える。
# 出力: /mnt/cache3/sattori-<game>-verify/phase99/bench/<ラベル>/
set -u
GAME=$1; LABEL=$2; REPLAY=$3; CPUS=${4:-0-15}
REPO=$(cd "$(dirname "$0")/.." && pwd)
O=/mnt/cache3/sattori-$GAME-verify/phase99/bench/$LABEL; mkdir -p "$O"
M=${BENCH_MULT:-4}
export SPEED_HACK_MULTIPLIER=$M FPS_LIMIT_TARGET_HZ=$((60 * M)) CAPTURE_FRAME_RATE_HZ=30 STUTTER_PROBE_ACTIVE_UNTIL_SEC=0 MOD_MENU_TIME_SCALE=${MOD_MENU_TIME_SCALE:-1}
export LP_NUM_THREADS=${LP_NUM_THREADS:-$(taskset -c "$CPUS" nproc)}
EXTRA=()
[ "$GAME" = th15 ] && EXTRA+=(--cpu-display)
[ "$GAME" = th20 ] && EXTRA+=(--thprac)
INST=$REPO/instances/$GAME-multigame-recording-test
# BENCH_DXVK=<DXVKのx32ディレクトリ>: d3d9をDXVK(Vulkan、lavapipe)へ差し替える。
# ゲームディレクトリへd3d9.dllを置き、終了後に消す(prepare_instanceのrsyncは--deleteしない)。
if [ -n "${BENCH_DXVK:-}" ]; then
  cp -f "$BENCH_DXVK/d3d9.dll" "$INST/d3d9.dll"
  export WINEDLLOVERRIDES="d3d9=n,b" VK_DRIVER_FILES=/usr/share/vulkan/icd.d/lvp_icd.json
  export VK_ICD_FILENAMES=$VK_DRIVER_FILES DXVK_LOG_PATH=$O DXVK_LOG_LEVEL=${DXVK_LOG_LEVEL:-info}
  trap 'rm -f "$INST/d3d9.dll"' EXIT
fi
python3 "$REPO/scripts/99_thread_sampler.py" "$GAME.exe" "$O/threads.tsv" 2 &
taskset -c "$CPUS" python3 "$REPO/scripts/25_record_replay_e2e_multigame.py" --game "$GAME" "${EXTRA[@]}" \
  --replay "$REPLAY" --max-attempts 1 --max-duplicate-rate 100 --no-audio --output "$O/video.mp4" >"$O/run.log" 2>&1
echo "rc=$?" >>"$O/run.log"
cp -f "$INST/${GAME}_autoplay.log" "$O/" 2>/dev/null
wait
python3 "$REPO/scripts/99_bench_summary.py" "$O/${GAME}_autoplay.log" | tee "$O/summary.txt"
