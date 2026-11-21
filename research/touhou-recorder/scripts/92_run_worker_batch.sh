#!/bin/bash
# フェーズ92: 本番のsattori-worker-gpuイメージで th06nc を順に録画・変換する(ホストの ubuntu ユーザーで実行)。
# docker run のフラグは本番の UserData(sattori `apps/api/src/ec2.ts`)と同じ。1録画ごとに別コンテナ。
#
# Usage: scripts/92_run_worker_batch.sh <label> <replay> <倍率> <720p|1080p> <score> <尺秒> [...]
# 出力は ~/out/<label>/。完了ごとに ~/out/DONE_<label> を作る。全部終わると ~/out/ALL_DONE。
IMAGE=<AWS_ACCOUNT_ID>.dkr.ecr.eu-south-2.amazonaws.com/sattori-worker-gpu:latest
BUCKET=sattoristack-titleassetsbucketdd388921-7dfstszkrnl6
OUT=~/out; mkdir -p $OUT ~/assets-cache

GPU_NVIDIA_MOUNTS=""
for f in \
  /usr/lib/xorg/modules/drivers/nvidia_drv.so \
  /usr/lib/xorg/modules/extensions/libglxserver_nvidia.so* \
  /usr/lib/i386-linux-gnu/libnvidia-*.so* \
  /usr/lib/i386-linux-gnu/libGLX_nvidia.so* \
  /usr/lib/i386-linux-gnu/libEGL_nvidia.so* \
  /usr/lib/i386-linux-gnu/libGLESv1_CM_nvidia.so* \
  /usr/lib/i386-linux-gnu/libGLESv2_nvidia.so*; do
  [ -e "$f" ] && GPU_NVIDIA_MOUNTS="$GPU_NVIDIA_MOUNTS -v $f:$f:ro"
done
for d in /dev/nvidia*; do
  [ -e "$d" ] && GPU_NVIDIA_MOUNTS="$GPU_NVIDIA_MOUNTS --device $d"
done

while [ $# -ge 6 ]; do
  label=$1 replay=$2 mult=$3 res=$4 score=$5 dur=$6; shift 6
  dir=$OUT/$label; mkdir -p $dir
  env_args=(-e GAME=th06nc -e GPU_WORKER=1 -e AWS_DEFAULT_REGION=eu-south-2 -e AWS_REGION=eu-south-2
            -e TITLE_ASSETS_BUCKET=$BUCKET -e TITLE_ASSETS_CACHE_DIR=/assets-cache)
  [ "$mult" != "1" ] && env_args+=(-e FPS_LIMIT_TARGET_HZ=$((60 * mult)))
  [ "$res" = "1080p" ] && env_args+=(-e TH06NC_RESOLUTION=1080p)
  echo "=== $(date -Is) START $label replay=$replay mult=$mult res=$res"
  (mpstat 1 2>/dev/null || vmstat -n 1) > $dir/cpu.txt 2>&1 & CPU=$!
  nvidia-smi dmon -s puc -d 1 > $dir/gpu.txt 2>&1 & NV=$!
  start=$(date +%s)
  sudo docker run --rm --gpus all --ipc=host -e NVIDIA_DRIVER_CAPABILITIES=all -e NVIDIA_VISIBLE_DEVICES=all \
    -e VK_LOADER_DEBUG=all $GPU_NVIDIA_MOUNTS -v /tmp/.X11-unix:/tmp/.X11-unix -v /etc/vulkan/icd.d:/etc/vulkan/icd.d:ro \
    "${env_args[@]}" -v ~/verify:/verify:ro -v ~/replays:/replays:ro -v ~/assets-cache:/assets-cache -v $dir:/out/$label \
    --entrypoint python3 $IMAGE /verify/92_worker_run.py --replay /replays/$replay --out /out/$label \
    --score $score --duration $dur > $dir/run.log 2>&1
  rc=$?
  kill $CPU $NV 2>/dev/null
  sudo chown -R "$(id -u):$(id -g)" $dir
  # 録画直後の落ちフレーム解析(scripts/81)。ホストにffmpegが無いのでコンテナ内で行う。分離前の中間ファイルは容量のため消す
  if [ -f $dir/video_delivery.mp4 ]; then
    sudo docker run --rm -v ~/verify:/verify:ro -v $dir:/d --entrypoint sh $IMAGE -c "
      ffprobe -v error -show_entries format=duration,bit_rate:stream=codec_name,width,height -of default=nw=1 /d/video.mp4 > /d/probe_raw.txt
      ffprobe -v error -show_entries format=duration,bit_rate:stream=codec_name,width,height -of default=nw=1 /d/video_delivery.mp4 > /d/probe_delivery.txt
      python3 /verify/81_analyze_stutter_periodicity.py /d/video_delivery.mp4 --start 15 --duration 100000 > /d/stutter.txt 2>&1"
    rm -f $dir/video.video.mp4 $dir/video.audio.mov
  fi
  echo "=== $(date -Is) END $label rc=$rc elapsed=$(( $(date +%s) - start ))s"
  touch $OUT/DONE_$label
done
touch $OUT/ALL_DONE
