#!/bin/bash
# フェーズ91: CPU描画(Xvfb)での低速・等倍録画を recorder/(scripts/25)経由で順に行い、
# mpstatを並走記録する。
#
# Usage: scripts/91_run_slowmo_batch.sh <game> <label> <replay> <hz> [<game> <label> <replay> <hz> ...]
#   例: scripts/91_run_slowmo_batch.sh th15 th15_extra_30hz th15_08.rpy 30 th20 th20_hard_40hz th20_01.rpy 40
#   hz=60は等倍(FPS_LIMIT_TARGET_HZを渡さない)。
# 追加のscripts/25引数は環境変数 EXTRA_ARGS で渡す。
# 出力は ~/out/<label>.*(AWS検証インスタンス上での実行を想定)。
cd ~/touhou-recorder
OUT=~/out; mkdir -p $OUT
# 1/2倍速の全6面(th15で約67分)が収まるように延ばす(既定は40分)
export TIMEOUT_SEC=${TIMEOUT_SEC:-7200}
# linger下ではsystemdのユーザーソケット(pulseaudio.socket)が pulse/native を握っており、手動で
# 起動したpulseaudioと衝突してauto_nullへ接続できなくなる(reports/91)。手動起動に一本化する。
systemctl --user mask --now pulseaudio.socket pulseaudio.service >/dev/null 2>&1
pgrep -x pulseaudio >/dev/null || { rm -rf "$XDG_RUNTIME_DIR/pulse"; setsid nohup pulseaudio --exit-idle-time=-1 >/dev/null 2>&1 & sleep 3; }
pactl list short sources | grep -q auto_null.monitor || { echo "ERROR: auto_null.monitorがありません"; exit 1; }
while [ $# -ge 4 ]; do
  game=$1 label=$2 replay=$3 hz=$4; shift 4
  unset FPS_LIMIT_TARGET_HZ
  [ "$hz" != "60" ] && export FPS_LIMIT_TARGET_HZ=$hz
  case $game in
    th15) title_args=(--cpu-display) ;;  # 既定のGPU描画面を使わない
    th20) title_args=(--thprac) ;;       # デシンク対策で必須
    *) title_args=() ;;
  esac
  echo "=== $(date -Is) START $game $label replay=$replay hz=$hz"
  mpstat 1 > $OUT/$label.mpstat.txt 2>&1 & MP=$!
  start=$(date +%s)
  python3 scripts/25_record_replay_e2e_multigame.py --game $game --replay "$replay" \
    "${title_args[@]}" $EXTRA_ARGS --output $OUT/$label.mp4 > $OUT/$label.log 2>&1
  rc=$?
  kill $MP 2>/dev/null
  cp instances/$game-multigame-recording-test/${game}_autoplay.log $OUT/$label.modlog.txt 2>/dev/null
  echo "=== $(date -Is) END $game $label rc=$rc elapsed=$(( $(date +%s) - start ))s"
done
echo ALL_DONE
