#!/bin/bash
# 録画済み動画(640x480等)を720pにアップスケールするpost-process変換スクリプト。
# 処理時間を計測してvideo_duration_secと合わせて出力する(reports/21参照)。
#
# 使い方: scripts/21_upscale_to_720p.sh <input.mp4> <output.mp4>
set -euo pipefail

INPUT="$1"
OUTPUT="$2"

if [ ! -f "$INPUT" ]; then
  echo "エラー: ファイルが見つかりません: $INPUT" >&2
  exit 1
fi

# 入力のアスペクト比を保ったまま高さ720pxへスケールする(1280x720固定だと
# th07等の4:3コンテンツが16:9に引き伸ばされて歪むため、reports/21参照)。
SRC_WIDTH=$(ffprobe -v error -select_streams v:0 -show_entries stream=width -of csv=p=0 "$INPUT")
SRC_HEIGHT=$(ffprobe -v error -select_streams v:0 -show_entries stream=height -of csv=p=0 "$INPUT")
TARGET_WIDTH=$(python3 -c "print(round(${SRC_WIDTH} * 720 / ${SRC_HEIGHT} / 2) * 2)")

START=$(date +%s.%N)
ffmpeg -y -i "$INPUT" -vf "scale=${TARGET_WIDTH}:720:flags=lanczos" \
  -c:v libx264 -preset veryfast -crf 18 -pix_fmt yuv420p \
  -c:a copy \
  "$OUTPUT"
END=$(date +%s.%N)

ELAPSED=$(python3 -c "print(f'{${END} - ${START}:.1f}')")
VIDEO_DURATION=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$INPUT")

echo "input=${INPUT} output=${OUTPUT} elapsed_sec=${ELAPSED} video_duration_sec=${VIDEO_DURATION}"
