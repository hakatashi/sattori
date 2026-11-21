# th07リプレイ録画ワーカー用イメージ(AWS版)。
# cloud/docker/Dockerfile(GCP版)とほぼ同一構成だが、アップロード先が
# Cloud StorageからS3に変わるためgoogle-cloud-storageの代わりにboto3を使う。
# scripts/11_record_th07_replay_e2e.py が期待するディレクトリ構成
# (REPO/prefixes/th07-wined3d-gl, REPO/games/th07, REPO/mods/.../build)
# をそのまま/app以下に再現する。
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
COPY scripts/ /app/scripts/
# 録画パイプライン本体(scripts/25_record_replay_e2e_multigame.py はこのパッケージを呼ぶシム)
COPY recorder/ /app/recorder/
COPY games/th07/ /app/games/th07/
COPY prefixes/th07-wined3d-gl/ /app/prefixes/th07-wined3d-gl/
COPY mods/common/build/injector.exe /app/mods/common/build/
COPY mods/th07_replay_autoplay/build/th07_hook.dll /app/mods/th07_replay_autoplay/build/
COPY assets/watermark/watermark-60fps.webm /app/assets/watermark/watermark-60fps.webm

COPY cloud/docker/aws/entrypoint.py /app/entrypoint.py
RUN chmod +x /app/entrypoint.py && mkdir -p /app/instances /app/runs

ENTRYPOINT ["python3", "/app/entrypoint.py"]
