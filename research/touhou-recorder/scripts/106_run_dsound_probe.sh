#!/bin/bash
# DirectSoundの使い方の記録(reports/106)。通常の録画(実時間)をDSOUND_PROBE=1で回し、MODログを残す。
#
# 使い方: scripts/106_run_dsound_probe.sh <game> <ラベル> <リプレイ> [録画秒数(既定120)]
#   追加の環境変数はそのままゲームへ渡る(FRAME_SYNC_*と併用するときはEXTRA_ARGS="--frame-sync")。
# 出力: /mnt/cache3/sattori-<game>-verify/phase106/<ラベル>/
set -u
GAME=$1; LABEL=$2; REPLAY=$3; SECS=${4:-120}
REPO=$(cd "$(dirname "$0")/.." && pwd)
O=/mnt/cache3/sattori-$GAME-verify/phase106/$LABEL; mkdir -p "$O"
# shellcheck disable=SC2086
DSOUND_PROBE=1 LIBGL_ALWAYS_SOFTWARE=1 timeout "${RUN_TIMEOUT_SEC:-1800}" \
  python3 "$REPO/scripts/25_record_replay_e2e_multigame.py" --game "$GAME" --cpu-display \
  --replay "$REPLAY" --max-attempts 1 --max-duplicate-rate 100 --no-audio \
  --record-seconds "$SECS" --output "$O/video.mp4" ${EXTRA_ARGS:-} >"$O/run.log" 2>&1
echo "rc=$?" >>"$O/run.log"
cp -f "$REPO/instances/$GAME-multigame-recording-test/${GAME}_autoplay.log" "$O/" 2>/dev/null
grep -c "DSProbe" "$O/${GAME}_autoplay.log"
