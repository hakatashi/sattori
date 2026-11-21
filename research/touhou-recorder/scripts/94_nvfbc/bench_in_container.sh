#!/bin/bash
# フェーズ94: コンテナ内でGPU描画面だけを立て、x11grabとNvFBCの取り込み上限をゲーム無しで比べる。
# Usage(コンテナ内): bash /verify/94_nvfbc/bench_in_container.sh <w> <h> <fps>
W=$1 H=$2 FPS=$3
export DISPLAY=:103 __GL_SYNC_TO_VBLANK=0 vblank_mode=0
python3 - <<PY
import sys, os
sys.path.insert(0, "/app")
from types import SimpleNamespace
from recording.gpu_display import ensure_gpu_display
c = SimpleNamespace(display=":103", xvfb_screen="2200x1400x24", crtc_mode="${W}x${H}" if "$H" == "1080" else None)
ensure_gpu_display(c, dict(os.environ), print)
PY
xrandr --query | head -5
xrandr --query | grep '\*'
glxinfo | grep -E 'OpenGL renderer'
glxgears -geometry ${W}x${H}+0+0 > /tmp/gears.log 2>&1 &
sleep 4; cat /tmp/gears.log | tail -1
run_ff() { echo "--- $1"; shift; ( ffmpeg -hide_banner -nostdin -y "$@" 2>&1 | tr '\r' '\n' | grep -E 'frame=|rror' | tail -1 | cut -c1-120 ) & p=$!; sleep 1; top -b -d 3 -n 3 -o %CPU | grep -E 'Xorg|ffmpeg|glxgears|nvfbc' | tail -3 | awk '{print $9, $12}' | tr '\n' ';'; echo; wait $p; }
run_ff "x11grab null (rawvideo, no encode)" -t 10 -f x11grab -draw_mouse 0 -video_size ${W}x${H} -framerate $FPS -i :103+0,0 -vsync 0 -f null -
run_ff "x11grab h264_nvenc bgr0" -t 10 -f x11grab -draw_mouse 0 -video_size ${W}x${H} -framerate $FPS -i :103+0,0 -vsync 0 -c:v h264_nvenc -preset p4 -rc vbr -cq 23 -b:v 5M -maxrate 6M /tmp/a.mp4
run_ff "x11grab h264_nvenc yuv420p(本番)" -t 10 -f x11grab -draw_mouse 0 -video_size ${W}x${H} -framerate $FPS -i :103+0,0 -vsync 0 -c:v h264_nvenc -preset p4 -rc vbr -cq 23 -b:v 5M -maxrate 6M -pix_fmt yuv420p /tmp/b.mp4
for spec in "sys 1" "cuda 1" "cuda 5" "cuda 1 push" "sys 1 push"; do
  set -- $spec
  echo "--- nvfbc $spec"
  /verify/94_nvfbc/nvfbc_probe $1 8 0 0 $W $H $2 $3 2>&1 | tail -4 &
  p=$!; sleep 3; top -b -n 1 -o %CPU | grep -E 'Xorg|glxgears|nvfbc' | awk '{print $9, $12}' | tr '\n' ';'; echo; wait $p
done
