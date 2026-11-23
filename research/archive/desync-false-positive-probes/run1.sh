#!/bin/bash
# usage: run1.sh <jobname> <tag>  -> frame sync recording into /mnt/cache3/sattori-desync-verify/debug/<job>-<tag>
set -e
J=$1; TAG=$2; G=${J%%-*}
B=/mnt/cache3/sattori-desync-verify
D=$B/debug/$J-$TAG
SRC=$B/assets/$G; [ -d $SRC/games ] || SRC=$(ls -d /home/hakatashi/.cache/sattori-home-worker/title-assets/$G/v-* | tail -1)
sudo rm -rf $D; mkdir -p $D/output/diagnostics $D/output/progress
sudo cp -a $SRC $D/assets && sudo chown -R root:root $D/assets
PREFIX=$(basename $(ls -d $D/assets/prefixes/* | head -1))
EST=$(python3 -c "import json;print(json.load(open('$B/jobs/$J/job.json'))['estimatedDurationSeconds'])")
SCORE=$(python3 -c "import json;print(json.load(open('$B/jobs/$J/job.json'))['replayInfo']['score'])")
docker run --rm --name sattori-dbg-$J --cpuset-cpus ${CPUSET:-0-3,8-11} \
  -v $D/assets:/mnt/$G-assets -v $B/jobs/$J/replay.rpy:/mnt/replay.rpy:ro -v $D/output:/mnt/output \
  -e CAPTURE_MODE=frame_sync -e WINEPREFIX=/mnt/$G-assets/prefixes/$PREFIX \
  -e SATTORI_GAME_DIR=/mnt/$G-assets/games/$G -e SATTORI_MOD_DIR=/mnt/$G-assets/mods $EXTRA_ENV \
  --entrypoint bash ${SATTORI_ECR_REPO}:latest -c "
pulseaudio -D --exit-idle-time=-1 --disallow-exit; sleep 1
timeout --kill-after=30s 7800s python3 record_$G.py --replay-path /mnt/replay.rpy --output /mnt/output/video.mp4 \
 --diagnostics-dir /mnt/output/diagnostics --progress-dir /mnt/output/progress --expected-duration-seconds $EST \
 --expected-score $SCORE --desync-result-path /mnt/output/desync_result.json --max-attempts 1; rc=\$?
cp /app/instances/*/*_autoplay.log /mnt/output/ 2>/dev/null; exit \$rc" > $D/run.log 2>&1 || true
sudo chown -R hakatashi:hakatashi $D; sudo rm -rf $D/assets
echo "RUN_DONE $J $TAG"
