#!/usr/bin/env bash
# フェーズ89: 倍速録画検証用のAWS GPUインスタンス(g6f、Deep Learning Base OSS Nvidia
# Driver GPU AMI (Ubuntu 24.04))をホスト直接導入で構築する。reports/87 §1.1 の手順を
# そのままスクリプト化したもの(落とし穴 §1.2 の対策込み)。
#
# インスタンス上で ubuntu ユーザーとして実行する:
#   bash 89_setup_gpu_instance.sh
# 完了後、~hakatashi/touhou-recorder へリポジトリ一式を転送して使う。
set -euxo pipefail

export DEBIAN_FRONTEND=noninteractive
# 付属ドライバはvGPU(GRID)で動かないので撤去する(docs/gpu-recording.md)
sudo apt-get remove --allow-change-held-packages -y 'nvidia-*' 'libnvidia-*' || true
sudo dpkg --add-architecture i386
sudo apt-get update
sudo apt-get install -y --no-install-recommends wine wine32 wine64 xdotool openbox x11-utils \
  x11-xserver-utils mesa-utils xserver-xorg-core xserver-xorg-input-libinput ffmpeg \
  pulseaudio pulseaudio-utils language-pack-ja python3-numpy python3-pil rsync sysstat zstd \
  dkms build-essential libgl1:i386 libglx0:i386 libglvnd0:i386 libegl1:i386 libvulkan1:i386 \
  fonts-noto-cjk

mkdir -p ~/grid
aws s3 cp --no-sign-request --recursive s3://ec2-linux-nvidia-drivers/latest/ ~/grid/ \
  --exclude '*' --include '*grid-aws.run'
sudo sh ~/grid/NVIDIA-Linux-x86_64-*-grid-aws.run --silent --dkms \
  --compat32-libdir=/usr/lib/i386-linux-gnu
# 既知の誤配置の修正(docs/gpu-recording.md)
if [ -d /usr/usr/lib/i386-linux-gnu ]; then
  sudo cp -a /usr/usr/lib/i386-linux-gnu/* /usr/lib/i386-linux-gnu/
  sudo ldconfig
fi
nvidia-smi

# WINEPREFIXのユーザー名に合わせる。SSH切断で /run/user/<uid> が消えないよう linger
id hakatashi >/dev/null 2>&1 || sudo useradd -m -s /bin/bash -G sudo hakatashi
echo 'hakatashi ALL=(ALL) NOPASSWD:ALL' | sudo tee /etc/sudoers.d/hakatashi
sudo loginctl enable-linger hakatashi
sudo mkdir -p ~hakatashi/.ssh
sudo cp ~/.ssh/authorized_keys ~hakatashi/.ssh/
sudo chown -R hakatashi:hakatashi ~hakatashi/.ssh
echo SETUP_DONE
