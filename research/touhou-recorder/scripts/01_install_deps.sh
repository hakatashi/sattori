#!/usr/bin/env bash
# ホストに必要なパッケージ(wine, winetricks, xdotool, vulkan-tools)とja_JP.UTF-8ロケールを導入する。
# 冪等に実行できる想定(既に入っていればaptがno-opにする)。
set -euo pipefail

sudo dpkg --add-architecture i386
sudo apt-get update
sudo apt-get install -y \
  wine wine32 wine64 winetricks \
  xdotool \
  vulkan-tools mesa-vulkan-drivers mesa-vulkan-drivers:i386 \
  language-pack-ja

sudo locale-gen ja_JP.UTF-8
sudo update-locale

echo "=== wine --version ==="
wine --version
echo "=== locale -a (ja) ==="
locale -a | grep -i ja
