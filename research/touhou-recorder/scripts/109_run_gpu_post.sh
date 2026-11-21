#!/usr/bin/env bash
# フェーズ109: GPUインスタンス上で40秒設定プローブとNVENC動画変換ベンチを実行する。
set -uo pipefail
OUT="${1:-$HOME/out}"
cd "$(dirname "$0")/.."
SKIP_ALL_DONE=1 EXTRA_ARGS="--record-seconds 40" USE_GPU_ENCODE=0 FRAME_SYNC_SKIP_PRESENT=0 \
  bash scripts/109_run_cloud_framesync_batch.sh "$OUT" gpu th15 th15_probe_x264_pres0 th15_08.rpy
SKIP_ALL_DONE=1 EXTRA_ARGS="--record-seconds 40" USE_GPU_ENCODE=1 FRAME_SYNC_SKIP_PRESENT=0 \
  bash scripts/109_run_cloud_framesync_batch.sh "$OUT" gpu th15 th15_probe_nvenc_pres0 th15_08.rpy
SKIP_ALL_DONE=1 EXTRA_ARGS="--record-seconds 40" USE_GPU_ENCODE=1 FRAME_SYNC_SKIP_PRESENT=1 \
  bash scripts/109_run_cloud_framesync_batch.sh "$OUT" gpu th15 th15_probe_nvenc_skip1 th15_08.rpy
python3 scripts/109_bench_convert.py --gpu-encode "$OUT/th12_extra.mp4" > "$OUT/convert_bench.txt" 2>&1
python3 scripts/109_bench_convert.py --gpu-encode "$OUT/th15_extra.mp4" >> "$OUT/convert_bench.txt" 2>&1
