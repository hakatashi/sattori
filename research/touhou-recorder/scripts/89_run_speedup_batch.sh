#!/bin/bash
# フェーズ89: 各タイトルを倍率ごとに recorder/(scripts/25)経由で順に録画し、mpstat/nvidia-smiを
# 並走記録する(scripts/87_run_speedup_batch.sh のタイトル汎用版)。
#
# Usage: scripts/89_run_speedup_batch.sh <game> <label> <replay> <倍率> [<game> <label> <replay> <倍率> ...]
#   例: scripts/89_run_speedup_batch.sh th07 th07_hard_2x th7_09.rpy 2 th10 th10_2x - 2
#   replayに "-" を渡すとタイトルの既定リプレイを使う。
# 追加のscripts/25引数は環境変数 EXTRA_ARGS で渡す(既定: --gpu-display --gpu-encode)。
# 出力は ~/out/<label>.*(AWS検証インスタンス上での実行を想定)。
cd ~/touhou-recorder
OUT=~/out; mkdir -p $OUT; rm -f $OUT/ALL_DONE
EXTRA_ARGS=${EXTRA_ARGS:---gpu-display --gpu-encode}
pgrep -x pulseaudio >/dev/null || { setsid nohup pulseaudio --exit-idle-time=-1 >/dev/null 2>&1 & sleep 3; }
while [ $# -ge 4 ]; do
  game=$1 label=$2 replay=$3 mult=$4; shift 4
  unset FPS_LIMIT_TARGET_HZ SPEED_HACK_MULTIPLIER
  if [ "$mult" != "1" ]; then
    hz=$(python3 -c "print(round(60*$mult))")
    # fps暴走検知の閾値は recorder/modlog.py が倍率に応じて自動で引き上げる(reports/89)
    export FPS_LIMIT_TARGET_HZ=$hz SPEED_HACK_MULTIPLIER=$mult
  fi
  # 1枚のvGPU上で複数のXorg(GPU描画面)を起動すると、最後にVTを取ったXorgしか描画が
  # 進まない(先に起動していた画面のゲームはFpsMonitor 0Hzで固まる、reports/89)。
  # タイトルごとに表示番号が違うので、毎回すべてのGPU描画面を止めてから始める。
  for d in $(ps -eo args | grep -o "Xorg :[0-9]* -config" | grep -o ":[0-9]*" | sort -u); do
    scripts/78_start_gpu_display.sh --display $d --stop 2>/dev/null
    sudo rm -f /tmp/.X${d#:}-lock /tmp/.X11-unix/X${d#:}
  done
  replay_args=()
  [ "$replay" != "-" ] && replay_args=(--replay "$replay")
  echo "=== $(date -Is) START $game $label replay=$replay mult=$mult hz=${FPS_LIMIT_TARGET_HZ:-60}"
  mpstat 1 > $OUT/$label.mpstat.txt 2>&1 & MP=$!
  nvidia-smi dmon -s u -d 1 > $OUT/$label.gpu.txt 2>&1 & NV=$!
  start=$(date +%s)
  python3 scripts/25_record_replay_e2e_multigame.py --game $game "${replay_args[@]}" $EXTRA_ARGS \
    --output $OUT/$label.mp4 > $OUT/$label.log 2>&1
  rc=$?
  kill $MP $NV 2>/dev/null
  cp instances/$game-multigame-recording-test/${game}_autoplay.log $OUT/$label.modlog.txt 2>/dev/null
  echo "=== $(date -Is) END $game $label rc=$rc elapsed=$(( $(date +%s) - start ))s"
  # 録画1本ごとの完了マーカー(scripts/103_pull_results.shが1本ずつ回収する、reports/103)
  echo "rc=$rc elapsed=$(( $(date +%s) - start ))" > $OUT/$label.done
done
touch $OUT/ALL_DONE
echo ALL_DONE
