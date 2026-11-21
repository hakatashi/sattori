#!/bin/bash
# フェーズ91: th20の低速録画の起動〜再生開始を反復し、難易度確認画面でのハング
# (hakatashi/sattori-dev#179)が起きないかを確認する。1回あたり再生開始から120秒だけ録画する。
#
# Usage: scripts/91_run_startup_repeat.sh <回数> [<hz>=30]
n=$1; hz=${2:-30}
for i in $(seq 1 "$n"); do
  EXTRA_ARGS="--record-seconds 120" bash ~/touhou-recorder/scripts/91_run_slowmo_batch.sh \
    th20 "startup_${hz}hz_$i" th20_01.rpy "$hz" | grep -E "END|ERROR"
  log=~/out/startup_${hz}hz_$i.modlog.txt
  echo "run$i last_score=$(grep -o 'ScoreMonitor: score=[0-9]*' "$log" | tail -1 | cut -d= -f2) \
last_fps=$(grep FpsMonitor "$log" | tail -1 | grep -o '([0-9.]* Hz)')"
  rm -f ~/out/startup_${hz}hz_$i.mp4 ~/out/startup_${hz}hz_$i.video.mp4 ~/out/startup_${hz}hz_$i.audio.m4a
done
echo REPEAT_DONE
