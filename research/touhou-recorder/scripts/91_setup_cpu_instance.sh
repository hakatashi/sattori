#!/usr/bin/env bash
# フェーズ91: CPU録画検証用のEC2インスタンス(c7i系、Ubuntu 24.04)をホスト直接導入で構築する。
# パッケージは cloud/docker/aws/Dockerfile.th20 と同じ(Xvfb + wined3d + llvmpipe)。
#
# インスタンス上で ubuntu ユーザーとして実行する:
#   bash 91_setup_cpu_instance.sh
# 完了後、~hakatashi/touhou-recorder へリポジトリ一式を転送して使う。
set -euxo pipefail

export DEBIAN_FRONTEND=noninteractive
# 録画中のapt自動更新によるCPU競合を避ける
sudo systemctl disable --now unattended-upgrades apt-daily.timer apt-daily-upgrade.timer || true
sudo dpkg --add-architecture i386
sudo apt-get update
sudo apt-get install -y --no-install-recommends wine wine32 wine64 xdotool xvfb openbox x11-utils \
  procps rsync ffmpeg pulseaudio pulseaudio-utils libgl1-mesa-dri:amd64 libgl1-mesa-dri:i386 \
  libgl1:amd64 libgl1:i386 libglx-mesa0:amd64 libglx-mesa0:i386 libegl-mesa0:amd64 \
  libegl-mesa0:i386 language-pack-ja python3 python3-numpy python3-pil sysstat zstd
sudo locale-gen ja_JP.UTF-8

# WINEPREFIXのユーザー名に合わせる。SSH切断で /run/user/<uid> が消えないよう linger
id hakatashi >/dev/null 2>&1 || sudo useradd -m -s /bin/bash -G sudo hakatashi
echo 'hakatashi ALL=(ALL) NOPASSWD:ALL' | sudo tee /etc/sudoers.d/hakatashi
sudo loginctl enable-linger hakatashi
sudo mkdir -p ~hakatashi/.ssh
sudo cp ~/.ssh/authorized_keys ~hakatashi/.ssh/
sudo chown -R hakatashi:hakatashi ~hakatashi/.ssh
echo SETUP_DONE
