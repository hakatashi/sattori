#!/bin/bash
# 録画動画の指定区間について、mpdecimateフィルタで重複フレーム率を計測する。
# フェーズ15/16で行っていたアドホックな計測手順(mpdecimateでユニークフレーム数を
# 数え、区間の総フレーム数と比較する)を再利用可能な形にしたもの。
#
# 使い方: scripts/measure_duplicate_frame_rate.sh <video.mp4> [start_sec=0] [duration_sec=60]
set -euo pipefail

VIDEO="$1"
START="${2:-0}"
DURATION="${3:-60}"

if [ ! -f "$VIDEO" ]; then
  echo "エラー: ファイルが見つかりません: $VIDEO" >&2
  exit 1
fi

TOTAL_FRAMES=$(ffprobe -v error -select_streams v:0 \
  -read_intervals "${START}%+${DURATION}" \
  -show_entries frame=pkt_pts_time -of csv=p=0 "$VIDEO" | wc -l)

UNIQUE_FRAMES=$(ffmpeg -nostdin -i "$VIDEO" -ss "$START" -t "$DURATION" \
  -vf mpdecimate -vsync 0 -an -f null - 2>&1 \
  | grep -Eo 'frame=[ ]*[0-9]+' | tail -1 | grep -Eo '[0-9]+')

DUP_RATE=$(python3 -c "print(f'{max(0.0, (1 - ${UNIQUE_FRAMES}/${TOTAL_FRAMES})*100):.1f}')")

echo "video=${VIDEO} start=${START}s duration=${DURATION}s total_frames=${TOTAL_FRAMES} unique_frames=${UNIQUE_FRAMES} duplicate_rate=${DUP_RATE}%"
