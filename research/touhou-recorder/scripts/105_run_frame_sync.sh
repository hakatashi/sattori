#!/bin/bash
# フレーム同期キャプチャ(reports/105)の検証用ランナー。ローカルのXvfb(CPU描画)で1本録り、
# MODログの集計(scripts/105_frame_sync_summary.py)まで行う。
#
# 使い方: scripts/105_run_frame_sync.sh <game> <ラベル> <リプレイ> [録画秒数(動画上、省略時は最後まで)]
#   追加の環境変数(FRAME_SYNC_*、LP_NUM_THREADS等)はそのままゲーム・録画側へ渡る。
#   EXTRA_ARGS で scripts/25 への追加引数(--thprac等)を渡せる。
# 出力: /mnt/cache3/sattori-<game>-verify/phase105/<ラベル>/
set -u
GAME=$1; LABEL=$2; REPLAY=$3; SECONDS_ARG=${4:-}
REPO=$(cd "$(dirname "$0")/.." && pwd)
O=/mnt/cache3/sattori-$GAME-verify/${PHASE_DIR:-phase105}/$LABEL; mkdir -p "$O"
ARGS=(--game "$GAME" --cpu-display --frame-sync --replay "$REPLAY" --max-attempts 1
      --max-duplicate-rate 100 --output "$O/video.mp4")
[ -n "$SECONDS_ARG" ] && ARGS+=(--record-seconds "$SECONDS_ARG")
# shellcheck disable=SC2086
LIBGL_ALWAYS_SOFTWARE=1 timeout "${RUN_TIMEOUT_SEC:-3600}" \
  python3 "$REPO/scripts/25_record_replay_e2e_multigame.py" "${ARGS[@]}" ${EXTRA_ARGS:-} >"$O/run.log" 2>&1
echo "rc=$?" >>"$O/run.log"
cp -f "$REPO/instances/$GAME-multigame-recording-test/${GAME}_autoplay.log" "$O/" 2>/dev/null
grep -E "FRAME_SYNC|ERROR|WARNING|^rc=|録画終了" "$O/run.log" | cut -c1-240
python3 "$REPO/scripts/105_frame_sync_summary.py" "$O/${GAME}_autoplay.log" "${SUMMARY_BIN_FRAMES:-3600}" | tee "$O/summary.txt"
