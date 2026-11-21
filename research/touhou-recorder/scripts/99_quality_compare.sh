#!/bin/bash
# 内部解像度1280x960と960x720の画質比較用の静止画を作る(reports/99)。
# 同じリプレイを等倍で短く録り、配信版と同じく1440x1080へlanczosで拡大して、同じ位置を切り出して並べる。
# 使い方: scripts/99_quality_compare.sh <th15|th20> <リプレイ> <960x720のcfg> <秒数> <切り出す時刻(秒)...>
set -u
GAME=$1; REPLAY=$2; CFG720=$3; SEC=$4; shift 4
REPO=$(cd "$(dirname "$0")/.." && pwd)
O=/mnt/cache3/sattori-$GAME-verify/phase99/quality; mkdir -p "$O"
EXTRA=(); [ "$GAME" = th15 ] && EXTRA+=(--cpu-display); [ "$GAME" = th20 ] && EXTRA+=(--thprac)
run() {  # <ラベル> [env...]
  local label=$1; shift
  [ -s "$O/$label.mp4" ] && return
  env "$@" python3 "$REPO/scripts/25_record_replay_e2e_multigame.py" --game "$GAME" "${EXTRA[@]}" --replay "$REPLAY" \
    --max-attempts 1 --max-duplicate-rate 95 --record-seconds "$SEC" --output "$O/$label.mp4" >"$O/$label.log" 2>&1
}
run r960
run r720 GAME_CFG_OVERRIDE="$CFG720"
for t in "$@"; do
  for l in r960 r720; do
    ffmpeg -nostdin -loglevel error -y -ss "$t" -i "$O/$l.mp4" -frames:v 1 -vf "scale=1440:1080:flags=lanczos" "$O/${l}_${t}.png"
  done
  # 左: 1280x960由来、右: 960x720由来。プレイフィールド左上寄りの720x720を切り出す
  ffmpeg -nostdin -loglevel error -y -i "$O/r960_${t}.png" -i "$O/r720_${t}.png" \
    -filter_complex "[0:v]crop=720:720:72:40[a];[1:v]crop=720:720:72:40[b];[a][b]hstack" "$O/compare_${t}.png"
  echo "$O/compare_${t}.png"
done
