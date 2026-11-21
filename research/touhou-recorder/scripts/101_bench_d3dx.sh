#!/usr/bin/env bash
# フェーズ101: 文字のジャギー対策(案A: MOD 側の縮小 / 案B: ネイティブ d3dx9_43.dll)の負荷比較。
#
# Usage: scripts/101_bench_d3dx.sh <out_dir> <record_seconds|full> <cpus|all> <mode...>
#   mode: builtin(現行) / area(案A、D3DX_AREA_FILTER=1) / native(案B)
#   cpus: taskset に渡す CPU リスト(例 "0-3")。all なら制限しない。
#   環境変数 BENCH_TIMING=1 で D3DX_TIMING=1(d3dx9 の関数ごとの計時)を付ける。
#   計時のラッパー自体にも少し時間がかかるため、CPU 時間・落ち率の比較は BENCH_TIMING なしで行う。
#
# 各 mode について <out_dir>/<mode>/ に video.mp4・recorder.log・autoplay.log・cpu.txt を残す。
# cpu.txt は th13.exe の utime+stime(clock tick)を 1 秒ごとに読んだ最後の値と経過秒。
# 案Bの DLL はインスタンスのディレクトリに一時的に置き、終わったら必ず消す(recorder の rsync は
# --delete しないので、残すと以降の録画すべてがネイティブ DLL になる)。
set -uo pipefail

OUT="$1"; SECS="$2"; CPUS="$3"; shift 3
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INST="$REPO/instances/th13-multigame-recording-test"
NATIVE_DLL="${NATIVE_DLL:-/mnt/cache3/sattori-th13-fontaa/dxredist/x/d3dx9_43.dll}"
TICK=$(getconf CLK_TCK)

cleanup() { rm -f "$INST/d3dx9_43.dll"; }
trap cleanup EXIT

sample_cpu() {  # th13.exe の CPU 時間を 1 秒ごとに記録する(終了マーカーが出来たら抜ける)
  local outf="$1" stop="$2" last="" t0; t0=$(date +%s)
  while [ ! -e "$stop" ]; do
    for p in /proc/[0-9]*; do
      [ "$(cat "$p/comm" 2>/dev/null)" = "th13.exe" ] || continue
      read -r -a f < "$p/stat" 2>/dev/null || continue
      # comm に空白は無いので、utime=14 番目・stime=15 番目(配列では 13・14)
      last="$((f[13] + f[14])) $(($(date +%s) - t0)) pid=${p#/proc/}"
    done
    [ -n "$last" ] && echo "$last tick=$TICK" > "$outf"
    sleep 1
  done
}

for mode in "$@"; do
  d="$OUT/$mode"; mkdir -p "$d"; rm -f "$d"/*
  cleanup
  envs=(); [ "${BENCH_TIMING:-0}" = 1 ] && envs+=(D3DX_TIMING=1)
  case "$mode" in
    builtin) ;;
    area) envs+=(D3DX_AREA_FILTER=1) ;;
    native) cp "$NATIVE_DLL" "$INST/"; envs+=(WINEDLLOVERRIDES=d3dx9_43=n,b) ;;
    *) echo "unknown mode $mode"; exit 2 ;;
  esac
  args=(--game th13 --replay th13_06.rpy --output "$d/video.mp4" --max-attempts 1)
  [ "$SECS" != full ] && args+=(--record-seconds "$SECS")
  pre=(); [ "$CPUS" != all ] && pre=(taskset -c "$CPUS")
  stop="$d/.stop"; rm -f "$stop"
  sample_cpu "$d/cpu.txt" "$stop" &
  sp=$!
  echo "[$(date +%T)] mode=$mode cpus=$CPUS secs=$SECS env=${envs[*]:-}"
  env "${envs[@]}" "${pre[@]}" python3 "$REPO/scripts/25_record_replay_e2e_multigame.py" "${args[@]}" \
    > "$d/recorder.log" 2>&1
  echo "[$(date +%T)] mode=$mode rc=$?"
  touch "$stop"; wait "$sp"
  cp "$INST/th13_autoplay.log" "$d/autoplay.log"
  cleanup
done
