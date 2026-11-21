#!/usr/bin/env bash
# th06ncのスコア変数のRVAを特定する(フェーズ79)。
#
# MOD(mods/th06nc_replay_autoplay)の ScanForValue プローブを使い、リプレイの
# 記録スコアと一致する32bit値を全コミット済みRWメモリから探す。異なるリプレイ
# (=異なる最終スコア)で2回実行し、共通して現れるRVAがスコア変数である
# (th06cのフェーズ74と同じ手法)。
#
# 【GPUを使わない】
# th06ncの録画にはGPU描画が要るが(reports/78 §5)、RVA特定に60fpsは不要である。
# 本マシンではth06ncのGPUコンテキスト破棄でamdgpuがフェンス待ちのまま固着する
# 問題があるため(reports/79)、このスクリプトは Xvfb + llvmpipe(ソフトウェア描画)
# で動かし、/dev/dri に一切触れないようにしている(LIBGL_ALWAYS_SOFTWARE=1)。
#
# llvmpipeでは1280x720で9fps程度しか出ず、MODの固定待ち時間(Sleep)では画面遷移
# アニメーションが終わる前に次のキーを送ってしまうため、TH06NC_TIME_SCALE で
# 待ちを引き延ばす(PressVKey自体はポーリング回数基準なのでfps非依存)。
#
# Usage:
#   scripts/79_th06nc_find_score_rva.sh --replay th6_07.rpy --score 514850 \
#       [--delay-ms 150000] [--repeat 6] [--interval-ms 20000] [--timeout 700]

set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PREFIX="$REPO/prefixes/th06nc-wined3d-gl"
INSTANCE="$REPO/instances/th06nc-test"
DISPLAY_NUM="${XVFB_DISPLAY:-:91}"
SCREEN="${XVFB_SCREEN:-2200x1400x24}"
REPLAY="th6_07.rpy"
SCORE=""
DELAY_MS=150000
REPEAT=6
INTERVAL_MS=20000
TIME_SCALE="${TH06NC_TIME_SCALE:-7}"
TIMEOUT=700

while [[ $# -gt 0 ]]; do
  case "$1" in
    --replay) REPLAY="$2"; shift 2 ;;
    --score) SCORE="$2"; shift 2 ;;
    --delay-ms) DELAY_MS="$2"; shift 2 ;;
    --repeat) REPEAT="$2"; shift 2 ;;
    --interval-ms) INTERVAL_MS="$2"; shift 2 ;;
    --time-scale) TIME_SCALE="$2"; shift 2 ;;
    --timeout) TIMEOUT="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

# --score を省略した場合はメモリ探索を行わず、リプレイを再生してMODの
# ScoreMonitor(kScoreRva特定後)のログを取るだけのモードになる。
# 特定済みRVAの妥当性を scripts/53_verify_replay_score.py で検証する用途。
FIND_ENABLED=1
if [[ -z "$SCORE" ]]; then
  FIND_ENABLED=0
  echo "--score 未指定のためメモリ探索は行いません(ScoreMonitorのログ取得のみ)" >&2
fi

cleanup() {
  echo "--- cleanup ---" >&2
  for p in $(ps -eo pid,args | grep '[t]h06nc\.exe' | awk '{print $1}'); do kill -9 "$p" 2>/dev/null; done
  WINEPREFIX="$PREFIX" timeout 30 wineserver -k 2>/dev/null
  for pid in $(ps -eo pid,comm | grep -E 'wine(server)?64?' | awk '{print $1}'); do
    if grep -qz "WINEPREFIX=$PREFIX" "/proc/$pid/environ" 2>/dev/null; then
      kill -9 "$pid" 2>/dev/null
    fi
  done
}
trap cleanup EXIT

# Xvfb(GPUを持たない純ソフトウェアのX画面)を用意する
if ! DISPLAY="$DISPLAY_NUM" timeout 5 xdpyinfo >/dev/null 2>&1; then
  echo "Xvfb $DISPLAY_NUM ($SCREEN) を起動します" >&2
  setsid nohup Xvfb "$DISPLAY_NUM" -screen 0 "$SCREEN" >/tmp/xvfb$DISPLAY_NUM.log 2>&1 &
  sleep 2
  DISPLAY="$DISPLAY_NUM" setsid nohup openbox --sm-disable >/tmp/openbox$DISPLAY_NUM.log 2>&1 &
  sleep 1
fi
DISPLAY="$DISPLAY_NUM" timeout 5 xdpyinfo >/dev/null 2>&1 || { echo "ERROR: $DISPLAY_NUM が起動しません" >&2; exit 1; }

# インスタンスディレクトリを準備(リプレイは対象1本だけ置く)
rsync -a --exclude=replay "$REPO/games/th06nc/" "$INSTANCE/" || exit 1
mkdir -p "$INSTANCE/replay"
rm -f "$INSTANCE/replay"/*
cp "$REPO/games/th06nc/replay/$REPLAY" "$INSTANCE/replay/" || exit 1
cp "$REPO/mods/th06nc_replay_autoplay/build/th06nc_hook.dll" \
   "$REPO/mods/th06c_steam_stub/build/steam_api64.dll" \
   "$REPO/mods/common/build/injector64.exe" "$INSTANCE/" || exit 1
# ゲームは終了時に th06.env を書き戻すため、毎回720p設定を置き直す
cp "$REPO/games/th06nc/th06.env.720p" "$INSTANCE/th06.env"
rm -f "$INSTANCE/th06nc_autoplay.log"

echo "replay=$REPLAY score=$SCORE time_scale=$TIME_SCALE delay=${DELAY_MS}ms repeat=$REPEAT" >&2

cd "$INSTANCE" || exit 1
# injector64.exe はDLLを注入するとすぐ終了し、ゲーム本体はwineserver配下で
# 動き続ける。ここで待たずに抜けると trap cleanup が即座にゲームを殺してしまう
# ので、注入後は「ゲームプロセスが消えるか TIMEOUT に達するまで」明示的に待つ。
FIND_ENV=()
if [[ "$FIND_ENABLED" -eq 1 ]]; then
  FIND_ENV=(TH06NC_FIND_VALUE="$SCORE" TH06NC_FIND_DELAY_MS="$DELAY_MS"
            TH06NC_FIND_REPEAT="$REPEAT" TH06NC_FIND_INTERVAL_MS="$INTERVAL_MS")
fi
env WINEPREFIX="$PREFIX" DISPLAY="$DISPLAY_NUM" LANG=ja_JP.UTF-8 \
  LIBGL_ALWAYS_SOFTWARE=1 \
  TH06NC_TIME_SCALE="$TIME_SCALE" \
  "${FIND_ENV[@]}" \
  timeout 60 wine injector64.exe th06nc.exe th06nc_hook.dll \
  > /tmp/th06nc_find_${REPLAY%.rpy}.log 2>&1

echo "注入完了。ゲーム本体の動作を最大 ${TIMEOUT}s 待ちます" >&2
deadline=$(( $(date +%s) + TIMEOUT ))
while [[ $(date +%s) -lt $deadline ]]; do
  # zombie(状態Z)は生存とみなさない
  alive=0
  for p in $(ps -eo pid,args | grep '[t]h06nc\.exe' | awk '{print $1}'); do
    st=$(awk '{print $3}' "/proc/$p/stat" 2>/dev/null)
    [[ "$st" != "Z" && -n "$st" ]] && alive=1
  done
  [[ "$alive" -eq 0 ]] && { echo "ゲームプロセスが終了しました" >&2; break; }
  # 指定回数のスキャンが全部終わっていたら待たずに抜ける
  # (MODは1回のScanForValueごとに "[find] 探索完了: N 件ヒット" を出力する)
  done_scans=$(grep -c "\[find\] 探索完了" "$INSTANCE/th06nc_autoplay.log" 2>/dev/null || echo 0)
  if [[ "$FIND_ENABLED" -eq 1 && "$done_scans" -ge "$REPEAT" ]]; then
    echo "全 $REPEAT 回のスキャンが完了しました" >&2
    break
  fi
  sleep 5
done

echo "=== [find] のヒット一覧 ===" >&2
grep -E "^\[.*\] \[find\]|\[menu\]" "$INSTANCE/th06nc_autoplay.log" 2>/dev/null >&2
