#!/bin/bash
# th06ncをXvfb上のCPU描画で短時間動かし、MODのFpsMonitorとスクリーンショットを取る(GPUに触れない、reports/96)。
# 使い方: scripts/96_cpu_render_probe.sh <ラベル> <秒数> [ICDのjson]
# 追加の環境変数(DXVK_*, LP_*, TH06NC_*)はそのままゲームへ渡る。
set -u
LABEL=$1; SEC=$2; ICD=${3:-/usr/share/vulkan/icd.d/lvp_icd.json}
REPO=$(cd "$(dirname "$0")/.." && pwd)
OUT=${OUT:-/mnt/cache3/sattori-th06nc-verify/phase96/probe/$LABEL}; mkdir -p "$OUT"
INST=${INST:-$REPO/instances/th06nc-multigame-recording-test}
DISP=${DISP:-:96}
export DISPLAY=$DISP WINEPREFIX=${WINEPREFIX:-$REPO/prefixes/th06nc-wined3d-gl} LANG=ja_JP.UTF-8 LC_ALL=ja_JP.UTF-8
export WINEDLLOVERRIDES=${WINEDLLOVERRIDES:-"d3d11,dxgi,d3d10core=n"} VK_DRIVER_FILES=$ICD VK_ICD_FILENAMES=$ICD LIBGL_ALWAYS_SOFTWARE=1
export DXVK_LOG_PATH=$OUT DXVK_LOG_LEVEL=info TH06NC_TIME_SCALE=${TH06NC_TIME_SCALE:-3}
# XvfbはRandRのリフレッシュレートが0HzでDXVKのdxgi.dllがゼロ除算する。Xorgのdummyドライバを使う。
if [ "${X_BACKEND:-dummy}" = xvfb ]; then
  # wined3d(OpenGL)経路はGLXが要る。Xvfbならllvmpipeになり、GPUには触れない。
  Xvfb $DISP -screen 0 2200x1400x24 +extension GLX >/dev/null 2>&1 & XV=$!
else
  LIBGL_ALWAYS_SOFTWARE=1 /usr/lib/xorg/Xorg $DISP -config "$REPO/scripts/96_cpu_render/xorg-dummy.conf" -logfile "$OUT/xorg.log" -noreset -nolisten tcp -extension GLX >/dev/null 2>&1 & XV=$!
fi
sleep 1; openbox >/dev/null 2>&1 & OB=$!
cleanup() {
  for p in $(ps -eo pid,comm | awk '$2 ~ /^th06nc/ {print $1}'); do kill -9 "$p" 2>/dev/null; done
  WINEPREFIX=$WINEPREFIX wineserver -k 2>/dev/null; sleep 1
  kill $OB $XV 2>/dev/null; wait $XV 2>/dev/null
}
trap cleanup EXIT
cd "$INST"; rm -f th06nc_autoplay.log
cp -f "$REPO/${TH06NC_ENV_FILE:-games/th06nc/th06.env.720p}" th06.env
wine injector64.exe th06nc.exe th06nc_hook.dll >"$OUT/wine.log" 2>&1 &
sleep "$SEC"
ffmpeg -nostdin -loglevel error -y -f x11grab -video_size 1920x1080 -i "$DISP" -frames:v 1 "$OUT/shot.png"
P=$(ps -eo pid,comm | awk '$2 ~ /^th06nc/ {print $1}' | head -1)
if [ -n "$P" ]; then
  ps -o pcpu,nlwp,etimes -p "$P" | tail -1 > "$OUT/cpu.txt"
  top -b -n1 -H -p "$P" | sed -n 8,30p > "$OUT/threads.txt"
  grep -c -E "/dev/(dri|kfd)" <(ls -l /proc/$P/fd) > "$OUT/dri_fds.txt"
fi
cp -f th06nc_autoplay.log "$OUT/" 2>/dev/null
grep -a FpsMonitor th06nc_autoplay.log | tail -6
cat "$OUT/cpu.txt" "$OUT/dri_fds.txt" 2>/dev/null
