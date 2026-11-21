#!/bin/bash
# フェーズ87: th15を倍率ごとに recorder/(scripts/25)経由で順に録画し、mpstat/nvidia-smiを並走記録する。
# Usage: scripts/87_run_speedup_batch.sh <label> <replay> <倍率> [<label> <replay> <倍率> ...]
#   例: scripts/87_run_speedup_batch.sh extra_2x th15_09.rpy 2 hard_2x th15_07.rpy 2
# 出力は ~/out/<label>.*(AWS検証インスタンス上での実行を想定)。
cd ~/touhou-recorder
OUT=~/out; mkdir -p $OUT
pgrep -x pulseaudio >/dev/null || { setsid nohup pulseaudio --exit-idle-time=-1 >/dev/null 2>&1 & sleep 3; }
while [ $# -ge 3 ]; do
  label=$1 replay=$2 mult=$3; shift 3
  unset FPS_LIMIT_TARGET_HZ SPEED_HACK_MULTIPLIER FPS_RUNAWAY_HZ_THRESHOLD
  if [ "$mult" != "1" ]; then
    hz=$(python3 -c "print(round(60*$mult))")
    export FPS_LIMIT_TARGET_HZ=$hz SPEED_HACK_MULTIPLIER=$mult
    export FPS_RUNAWAY_HZ_THRESHOLD=$(python3 -c "print(max(300, round($hz*1.3)))")
  fi
  echo "=== $(date -Is) START $label replay=$replay mult=$mult hz=${FPS_LIMIT_TARGET_HZ:-60}"
  mpstat 1 > $OUT/$label.mpstat.txt 2>&1 & MP=$!
  nvidia-smi dmon -s u -d 1 > $OUT/$label.gpu.txt 2>&1 & NV=$!
  start=$(date +%s)
  python3 scripts/25_record_replay_e2e_multigame.py --game th15 --replay $replay --gpu-encode \
    --output $OUT/$label.mp4 > $OUT/$label.log 2>&1
  rc=$?
  kill $MP $NV 2>/dev/null
  echo "=== $(date -Is) END $label rc=$rc elapsed=$(( $(date +%s) - start ))s"
done
echo ALL_DONE
