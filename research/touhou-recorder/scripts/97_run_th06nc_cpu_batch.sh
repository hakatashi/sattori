#!/bin/bash
# フェーズ97: th06ncのCPU描画(Xvfb + wined3d + llvmpipe、BC7展開、reports/96)での録画を
# recorder/(scripts/25)経由で順に行い、mpstatを並走記録する。
#
# Usage: scripts/97_run_th06nc_cpu_batch.sh <label> <replay> <speed> <res> [<label> <replay> <speed> <res> ...]
#   speed: 1(等倍)または 0.5(1/2倍速。FPS_LIMIT_TARGET_HZ=30・QPC偽装・MODの待ち2倍)
#   res:   720p または 1080p
#   例: scripts/97_run_th06nc_cpu_batch.sh lunatic_720p_half th6_20.rpy 0.5 720p
# 出力は ~/out/<label>.*。各録画の終了で ~/out/<label>.done、全体の終了で ~/out/ALL_DONE を作る
# (完了判定はこのマーカーで行う。pgrep -f は使わない、AGENTS.md)。
cd ~/touhou-recorder
OUT=~/out; mkdir -p $OUT
export TIMEOUT_SEC=${TIMEOUT_SEC:-7200}
# linger下のsystemdのpulseaudio.socketとの衝突を避ける(reports/91 §8)
systemctl --user mask --now pulseaudio.socket pulseaudio.service >/dev/null 2>&1
pgrep -x pulseaudio >/dev/null || { rm -rf "$XDG_RUNTIME_DIR/pulse"; setsid nohup pulseaudio --exit-idle-time=-1 >/dev/null 2>&1 & sleep 3; }
pactl list short sources | grep -q auto_null.monitor || { echo "ERROR: auto_null.monitorがありません"; exit 1; }

# CPU描画の共通設定(reports/96 §2)。プレフィックスのsystem32にはDXVKがあるのでビルトインを明示する
export D3D11_DECODE_BC7=1 WINEDLLOVERRIDES="d3d11,dxgi,d3d10core=b" GALLIUM_DRIVER=llvmpipe LIBGL_ALWAYS_SOFTWARE=1
NPROC=$(nproc)
export LP_NUM_THREADS=${LP_NUM_THREADS:-$NPROC}

while [ $# -ge 4 ]; do
  label=$1 replay=$2 speed=$3 res=$4; shift 4
  unset FPS_LIMIT_TARGET_HZ SPEED_HACK_MULTIPLIER TH06NC_TIME_SCALE TH06NC_ENV_FILE
  if [ "$speed" = "0.5" ]; then
    export FPS_LIMIT_TARGET_HZ=30 SPEED_HACK_MULTIPLIER=0.5 TH06NC_TIME_SCALE=2
  fi
  [ "$res" = "1080p" ] && export TH06NC_ENV_FILE=games/th06nc/th06.env.1080p
  echo "=== $(date -Is) START $label replay=$replay speed=$speed res=$res nproc=$NPROC"
  mpstat 1 > $OUT/$label.mpstat.txt 2>&1 & MP=$!
  start=$(date +%s)
  python3 scripts/25_record_replay_e2e_multigame.py --game th06nc --cpu-display --replay "$replay" \
    $EXTRA_ARGS --output $OUT/$label.mp4 > $OUT/$label.log 2>&1
  rc=$?
  kill $MP 2>/dev/null
  cp instances/th06nc-multigame-recording-test/th06nc_autoplay.log $OUT/$label.modlog.txt 2>/dev/null
  echo "=== $(date -Is) END $label rc=$rc elapsed=$(( $(date +%s) - start ))s"
  echo "rc=$rc elapsed=$(( $(date +%s) - start ))" > $OUT/$label.done
done
echo ALL_DONE
touch $OUT/ALL_DONE
