#!/bin/bash
# 本番ワーカーイメージでフレーム同期録画を1本走らせる(verify-recording-locally skill の手順を1本用にまとめたもの)。
# usage: run.sh <game> <fixture-name> <outer-timeout-sec> [docker追加引数...]
#   環境変数: B=作業ディレクトリ(既定 /mnt/cache3/sattori-spellprac-timeout-verify。$B/<game>/assets に
#             タイトル資産を root 所有で展開しておく)、RUN=出力ディレクトリ名、REC_ARGS=record_thNN.py への追加引数
#   イメージ: ${SATTORI_ECR_REPO}:latest(scripts/sattori-env.sh)
# 終了検知されないリプレイは <outer-timeout-sec> で打ち切る(EXIT=124)。打ち切られた録画は mp4 が未完成になるが、
# 終了検知が見ているサブ出力 output/repro.pollstream.raw(160x120 グレー、8fps)は残る。
g=$1; f=$2; t=$3; shift 3; RUN=${RUN:-run-$f}
B=${B:-/mnt/cache3/sattori-spellprac-timeout-verify}
D=$B/$g/$RUN
mkdir -p "$D/output/diagnostics" "$D/output/progress"
cp "$(git rev-parse --show-toplevel)/packages/replay-parser/test-fixtures/$g/$f.rpy" "$D/replay.rpy"
docker run --rm --name sattori-repro-$g-$f --cpus 4 \
  -v "$B/$g/assets:/mnt/$g-assets" -v "$D/replay.rpy:/mnt/replay.rpy:ro" -v "$D/output:/mnt/output" \
  -e WINEPREFIX=/mnt/$g-assets/prefixes/$g-wined3d-gl -e SATTORI_GAME_DIR=/mnt/$g-assets/games/$g \
  -e SATTORI_MOD_DIR=/mnt/$g-assets/mods -e CAPTURE_MODE=frame_sync "$@" \
  --entrypoint bash "${SATTORI_ECR_REPO:?source scripts/sattori-env.sh}:latest" \
  -c "pulseaudio -D --exit-idle-time=-1 --disallow-exit; sleep 1
      timeout --kill-after=30s ${t}s python3 record_$g.py --replay-path /mnt/replay.rpy --output /mnt/output/repro.mp4 \
      --diagnostics-dir /mnt/output/diagnostics --progress-dir /mnt/output/progress --expected-duration-seconds 60 --max-attempts 1 ${REC_ARGS}; echo EXIT=\$?" \
  > "$D/run.log" 2>&1
echo "DONE $g $f"
