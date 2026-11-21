#!/usr/bin/env bash
# フェーズ50: th20のリプレイずれ(デシンク)に対するthpracの効果を検証するバッチ。
#
# 同じリプレイを「thprac無し」「thprac有り」の両方でフル尺録画し、
# scripts/50_check_replay_desync.py で記録時スコアと再生時スコアを突き合わせる。
#
# th20は単体でCPUを大量に消費する(AWSでは16vCPU相当が必要)ため、必ず
# 逐次実行する。並列化すると処理落ちで総録画時間が伸び、デシンク判定の
# 材料である「想定尺との比較」が濁る。また thprac の `--attach`(PID無し)は
# 「最初に見つかった東方ゲームプロセス」に付くため、同一WINEPREFIXで
# 並列実行するとアタッチ先が不定になる。
#
# usage:
#   scripts/50_run_thprac_desync_batch.sh <replay>:<0|1> [<replay>:<0|1> ...]
#   TIMEOUT_SEC=5400 TAG_SUFFIX=_long scripts/50_run_thprac_desync_batch.sh th20_ud0000:1
#
# TIMEOUT_SEC は scripts/25 がそのまま参照する録画の強制打ち切り時間(既定2400秒)。
# 処理落ちの激しいスコアアタックリプレイ(th20_ud0000等)は既定値だとクリア前に
# 打ち切られてデシンクと区別できなくなるため、明示的に延ばすこと。
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

OUTROOT="${OUTROOT:-$REPO/runs/th20_thprac_desync}"
TAG_SUFFIX="${TAG_SUFFIX:-}"
LOGSRC="$REPO/instances/th20-multigame-recording-test/th20_autoplay.log"
mkdir -p "$OUTROOT"

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <replay>:<0|1> [...]" >&2
  exit 1
fi

for entry in "$@"; do
  replay="${entry%%:*}"
  thprac="${entry##*:}"
  tag="${replay}_$([ "$thprac" = 1 ] && echo thprac || echo plain)${TAG_SUFFIX}"
  outdir="$OUTROOT/$tag"
  mkdir -p "$outdir"

  if [ -f "$outdir/DONE" ]; then
    echo "[batch] skip $tag (already done)"
    continue
  fi

  echo "[batch] === $tag start $(date -Is) (TIMEOUT_SEC=${TIMEOUT_SEC:-default}) ==="
  args=(--game th20 --replay "${replay}.rpy" --max-attempts 1
        --output "$outdir/video.mp4")
  [ "$thprac" = 1 ] && args+=(--thprac)

  python3 scripts/25_record_replay_e2e_multigame.py "${args[@]}" \
    > "$outdir/record.log" 2>&1
  echo "[batch] $tag record rc=$? $(date -Is)"

  cp -f "$LOGSRC" "$outdir/th20_autoplay.log" 2>/dev/null

  # mux前の中間ファイルは容量が倍になるだけなので削除する
  rm -f "$outdir/video.video.mp4" "$outdir/video.audio.m4a"

  python3 scripts/50_check_replay_desync.py \
    "games/th20/replay/${replay}.rpy" "$outdir/th20_autoplay.log" \
    --record-log "$outdir/record.log" \
    > "$outdir/desync_check.txt" 2>&1
  echo "[batch] desync_check exit=$?"
  cat "$outdir/desync_check.txt"

  touch "$outdir/DONE"
  df -h /home | tail -1
done

echo "[batch] all done $(date -Is)"
