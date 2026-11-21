#!/bin/bash
# フェーズ100: th13のCPU描画(Xvfb + wined3d + llvmpipe)録画をAWS上でバッチ実行する。
# Usage: scripts/100_run_th13_cloud_batch.sh <label> <replay> [<label> <replay> ...]
# 出力は ~/out/<label>.*。各録画の終了で ~/out/<label>.done、全体の終了で ~/out/ALL_DONE。
cd ~/touhou-recorder
OUT=~/out; mkdir -p $OUT
export TIMEOUT_SEC=${TIMEOUT_SEC:-7200}
systemctl --user mask --now pulseaudio.socket pulseaudio.service >/dev/null 2>&1
pgrep -x pulseaudio >/dev/null || { rm -rf "$XDG_RUNTIME_DIR/pulse"; setsid nohup pulseaudio --exit-idle-time=-1 >/dev/null 2>&1 & sleep 3; }
pactl list short sources | grep -q auto_null.monitor || { echo "ERROR: auto_null.monitorがありません"; exit 1; }
export GALLIUM_DRIVER=llvmpipe LIBGL_ALWAYS_SOFTWARE=1
export LP_NUM_THREADS=${LP_NUM_THREADS:-$(nproc)}
rm -f $OUT/ALL_DONE
while [ $# -ge 2 ]; do
  label=$1 replay=$2; shift 2
  echo "=== $(date -Is) START $label replay=$replay nproc=$(nproc)"
  mpstat 1 > $OUT/$label.mpstat.txt 2>&1 & MP=$!
  start=$(date +%s)
  python3 scripts/25_record_replay_e2e_multigame.py --game th13 --cpu-display --replay "$replay" \
    $EXTRA_ARGS --output $OUT/$label.mp4 > $OUT/$label.log 2>&1
  rc=$?
  kill $MP 2>/dev/null
  cp instances/th13-multigame-recording-test/th13_autoplay.log $OUT/$label.modlog.txt 2>/dev/null
  echo "rc=$rc elapsed=$(( $(date +%s) - start ))" > $OUT/$label.done
done
touch $OUT/ALL_DONE
