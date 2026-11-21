#!/bin/bash
# フェーズ92: 録画バッチ(92_run_worker_batch.sh)の完了を待ち、倍速条件の生データを`-r 60`で再変換して
# scripts/81 で解析する(録画と重ならないように順番に実行する)。完了で ~/out/RECONVERT_DONE を作る。
#
# Usage: scripts/92_run_reconvert_batch.sh <label>:<倍率> [...]
IMAGE=<AWS_ACCOUNT_ID>.dkr.ecr.eu-south-2.amazonaws.com/sattori-worker-gpu:latest
OUT=~/out
until [ -e $OUT/ALL_DONE ]; do sleep 20; done
GPU_NVIDIA_MOUNTS=""
for d in /dev/nvidia*; do
  [ -e "$d" ] && GPU_NVIDIA_MOUNTS="$GPU_NVIDIA_MOUNTS --device $d"
done
for spec in "$@"; do
  label=${spec%%:*} mult=${spec##*:}
  dir=$OUT/$label
  echo "=== $(date -Is) START $label"
  sudo docker run --rm --gpus all $GPU_NVIDIA_MOUNTS -e NVIDIA_DRIVER_CAPABILITIES=all -e NVIDIA_VISIBLE_DEVICES=all -e GPU_WORKER=1 \
    -v ~/verify:/verify:ro -v $dir:/out/$label --entrypoint sh $IMAGE -c "
      python3 /verify/92_reconvert_r60.py /out/$label $mult > /out/$label/reconvert.log 2>&1
      python3 /verify/81_analyze_stutter_periodicity.py /out/$label/video_delivery_r60.mp4 --start 15 --duration 100000 > /out/$label/stutter_r60.txt 2>&1"
  echo "=== $(date -Is) END $label rc=$?"
done
touch $OUT/RECONVERT_DONE
