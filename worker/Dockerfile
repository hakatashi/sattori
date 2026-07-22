# Sattori 録画ワーカー(AWS EC2 Spot 上で実行)。
# Wine + Xvfb + ffmpeg + PulseAudio + Python によるリプレイ録画イメージ。
# touhou-recorder の PoC 構成 (cloud/docker/aws/Dockerfile) を刷新したもの。
#
# タイトル固有アセット(ゲーム本体・WINEPREFIX・MOD ビルド成果物)はこのイメージには
# 含めない。ECRストレージコストがタイトル数に比例して増大するため(Issue #22)、
# entrypoint.py が起動時に GAME 環境変数に応じて S3 からダウンロード・展開する
# (title_assets.py、アップロード手順は worker/README.md 参照)。このため本イメージは
# タイトル数に依存せず1本のみで、新タイトル追加時に再ビルドする必要はない。
#
# 重要: 以下はウォーターマーク素材であり、リポジトリには含めない(.gitignore 済み)。
# docker build 前にビルドコンテキスト(worker/)配下へ配置しておくこと
# (詳細は worker/README.md):
#   assets/watermark/watermark-60fps.webm … ウォーターマーク素材(VP9 アルファ、タイトル非依存の共通素材)
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

# ウォーターマーク素材(タイトル非依存の共通素材。ビルド時にコンテキストへ配置。
# リポジトリには含まれない)
COPY assets/watermark/watermark-60fps.webm /app/assets/watermark/watermark-60fps.webm

# ワーカーのソース(リポジトリ管理)
COPY recording_common.py record_th07.py record_th08.py entrypoint.py status.py upscale.py interruption_watcher.py progress_reporter.py title_assets.py /app/

RUN mkdir -p /app/instances /app/runs

ENTRYPOINT ["python3", "/app/entrypoint.py"]
