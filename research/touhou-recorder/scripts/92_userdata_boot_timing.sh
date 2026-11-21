#!/bin/bash
# フェーズ92: 本番のGPUワーカーのUserData(sattori `apps/api/src/ec2.ts` の buildUserData)と同じ手順で
# ECRログイン→pull→コンテナ起動まで進め、各段の時刻を /var/log/boot_timing.log へ記録する。
# awslogsドライバとジョブ固有の環境変数だけ本番と異なる。コンテナは起動を確認してすぐ終わる。
# 検証用なので起動から GUARD_MIN 分で自動終了する(インスタンス側の shutdown 動作は terminate)。
GUARD_MIN=__GUARD_MIN__
IMAGE=<AWS_ACCOUNT_ID>.dkr.ecr.eu-south-2.amazonaws.com/sattori-worker-gpu:latest
REGISTRY=${IMAGE%%/*}
export AWS_DEFAULT_REGION=eu-south-2
LOG=/var/log/boot_timing.log
stamp() { echo "$1 $(date +%s.%N)" >> $LOG; }

stamp userdata_start
shutdown -h +$GUARD_MIN "phase92 guard" || true

GPU_NVIDIA_MOUNTS=""
for f in \
  /usr/lib/xorg/modules/drivers/nvidia_drv.so \
  /usr/lib/xorg/modules/extensions/libglxserver_nvidia.so* \
  /usr/lib/i386-linux-gnu/libnvidia-*.so* \
  /usr/lib/i386-linux-gnu/libGLX_nvidia.so* \
  /usr/lib/i386-linux-gnu/libEGL_nvidia.so* \
  /usr/lib/i386-linux-gnu/libGLESv1_CM_nvidia.so* \
  /usr/lib/i386-linux-gnu/libGLESv2_nvidia.so*; do
  if [ -e "$f" ]; then
    GPU_NVIDIA_MOUNTS="$GPU_NVIDIA_MOUNTS -v $f:$f:ro"
  fi
done
for d in /dev/nvidia*; do
  if [ -e "$d" ]; then
    GPU_NVIDIA_MOUNTS="$GPU_NVIDIA_MOUNTS --device $d"
  fi
done
stamp mounts_done

systemctl enable --now docker >/dev/null 2>&1 || service docker start >/dev/null 2>&1 || true
stamp docker_started

aws ecr get-login-password --region eu-south-2 | docker login --username AWS --password-stdin $REGISTRY
stamp ecr_login_done

docker pull $IMAGE
stamp docker_pull_done

docker run --rm --gpus all --ipc=host -e NVIDIA_DRIVER_CAPABILITIES=all -e NVIDIA_VISIBLE_DEVICES=all \
  $GPU_NVIDIA_MOUNTS -v /tmp/.X11-unix:/tmp/.X11-unix -v /etc/vulkan/icd.d:/etc/vulkan/icd.d:ro \
  --entrypoint /bin/sh $IMAGE -c 'date +"container_start %s.%N"; nvidia-smi -L' >> $LOG 2>&1
stamp container_done

nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader >> $LOG 2>&1
stamp userdata_done
