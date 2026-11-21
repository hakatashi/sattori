#!/bin/bash
# 実ゲームプレイ区間(開始45秒以降)のFpsMonitorをCPU数・描画経路ごとに集計する(reports/96)。
# 使い方: matrix.sh <ラベル> <cpuset> <dxvk|wined3d> [秒数]
LABEL=$1; CPUS=$2; PATHSEL=$3; SEC=${4:-110}
REPO=$(cd "$(dirname "$0")/../.." && pwd); T=/mnt/cache3/sattori-th06nc-verify/phase96/probe
export INST=$REPO/instances/th06nc-probe D3D11_DECODE_BC7=${D3D11_DECODE_BC7:-1} TH06NC_TIME_SCALE=${TH06NC_TIME_SCALE:-1}
n=$(taskset -c "$CPUS" nproc); export LP_NUM_THREADS=${LP_NUM_THREADS:-$n}
if [ "$PATHSEL" = wined3d ]; then export WINEDLLOVERRIDES="d3d11,dxgi,d3d10core=b" GALLIUM_DRIVER=llvmpipe; fi
taskset -c "$CPUS" "$REPO/scripts/96_cpu_render_probe.sh" "$LABEL" "$SEC" >/dev/null 2>&1
python3 -I - "$T/$LABEL/th06nc_autoplay.log" "$LABEL" <<'PY'
import re,sys
hz=[float(m) for m in re.findall(r'FpsMonitor:.*\(([\d.]+) Hz\)',open(sys.argv[1],errors='ignore').read())]
play=hz[9:]
if play:
    s=sorted(play);print(sys.argv[2],'n',len(play),'median',s[len(s)//2],'min',s[0],'max',s[-1])
else: print(sys.argv[2],'NO DATA',hz)
PY
cat "$T/$LABEL/cpu.txt" 2>/dev/null
