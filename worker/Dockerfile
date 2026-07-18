# Sattori 録画ワーカー(AWS EC2 Spot 上で実行)。
# Wine + Xvfb + ffmpeg + PulseAudio + Python による th07 リプレイ録画イメージ。
# touhou-recorder の PoC 構成 (cloud/docker/aws/Dockerfile) を刷新したもの。
#
# 重要: 以下のディレクトリはゲーム本体(著作権物)・MOD ビルド成果物・ウォーター
# マーク素材であり、リポジトリには含めない(.gitignore 済み)。docker build 前に
# ビルドコンテキスト(worker/)配下へ配置しておくこと(詳細は worker/README.md):
#   games/th07/                       … th07 本体一式(ウィンドウモードの .cfg 必須)
#   prefixes/th07-wined3d-gl/         … 日本語ロケールで初期化済みの WINEPREFIX
#   mods/common/build/injector.exe    … DLL インジェクタ(Windows でビルド)
#   mods/th07_replay_autoplay/build/th07_hook.dll … 自動再生 MOD
#   assets/watermark/watermark-60fps.webm         … ウォーターマーク素材(VP9 アルファ)
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN dpkg --add-architecture i386 && \
    apt-get update && \
    apt-get install -y --no-install-recommends \
      wine wine32 wine64 winetricks \
      xdotool xvfb openbox x11-utils procps rsync \
      ffmpeg pulseaudio pulseaudio-utils \
      libgl1-mesa-dri:amd64 libgl1-mesa-dri:i386 \
      libgl1:amd64 libgl1:i386 \
      libglx-mesa0:amd64 libglx-mesa0:i386 \
      libegl-mesa0:amd64 libegl-mesa0:i386 \
      language-pack-ja \
      python3 python3-numpy python3-pil python3-pip \
      ca-certificates \
    && locale-gen ja_JP.UTF-8 && update-locale \
    && pip3 install --break-system-packages --no-cache-dir boto3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ゲーム資産(ビルド時にコンテキストへ配置。リポジトリには含まれない)
COPY games/th07/ /app/games/th07/
COPY prefixes/th07-wined3d-gl/ /app/prefixes/th07-wined3d-gl/
COPY mods/common/build/injector.exe /app/mods/common/build/
COPY mods/th07_replay_autoplay/build/th07_hook.dll /app/mods/th07_replay_autoplay/build/
COPY assets/watermark/watermark-60fps.webm /app/assets/watermark/watermark-60fps.webm

# ワーカーのソース(リポジトリ管理)
COPY record_th07.py entrypoint.py status.py upscale.py /app/

RUN mkdir -p /app/instances /app/runs

ENTRYPOINT ["python3", "/app/entrypoint.py"]
