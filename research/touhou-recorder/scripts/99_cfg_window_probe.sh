#!/bin/bash
# th15/th20のcfgの1バイトを書き換えて起動し、ウィンドウサイズを読む(reports/99)。
# 内部解像度(=ウィンドウサイズ)を決めるバイトを探すため。MODは注入しない。
# 使い方: scripts/99_cfg_window_probe.sh <th15|th20> <オフセット(10進)> <値(10進)>
set -u
GAME=$1; OFF=$2; VAL=$3
REPO=$(cd "$(dirname "$0")/.." && pwd)
W=/mnt/cache3/sattori-$GAME-verify/phase99/cfgprobe; mkdir -p $W
PFX=$W/prefix-$GAME; INST=$W/inst-$GAME
[ -d "$PFX" ] || cp -a --reflink=auto "$REPO/prefixes/$GAME-wined3d-gl" "$PFX"
[ -d "$INST" ] || rsync -a --exclude=replay "$REPO/games/$GAME/" "$INST/"
APPD=$PFX/drive_c/users/hakatashi/AppData/Roaming/ShanghaiAlice/$GAME
mkdir -p "$APPD"
cp -f "$REPO/games/$GAME/$GAME.cfg" "$APPD/$GAME.cfg"
printf "$(printf '\\x%02x' "$VAL")" | dd of="$APPD/$GAME.cfg" bs=1 seek="$OFF" conv=notrunc status=none
DISP=:199
Xvfb $DISP -screen 0 2200x1700x24 +extension GLX >/dev/null 2>&1 & XV=$!
sleep 1
export DISPLAY=$DISP WINEPREFIX=$PFX LANG=ja_JP.UTF-8 LC_ALL=ja_JP.UTF-8
cleanup() {
  for p in $(ps -eo pid,comm | awk -v g="$GAME.exe" '$2==g {print $1}'); do kill -9 "$p" 2>/dev/null; done
  wineserver -k 2>/dev/null; sleep 1; kill $XV 2>/dev/null; wait $XV 2>/dev/null
}
trap cleanup EXIT
(cd "$INST" && wine "$GAME.exe" >/dev/null 2>&1 &)
sleep 15
xwininfo -root -tree 2>/dev/null | grep -E " [0-9]{3,4}x[0-9]{3,4}\+" | head -5; ffmpeg -nostdin -loglevel error -y -f x11grab -video_size 2200x1700 -i $DISP -frames:v 1 -vf scale=550:-1 $W/shot_${OFF}_${VAL}.png
for id in $(xwininfo -root -tree 2>/dev/null | awk '/ [0-9]+x[0-9]+\+/ && /東方|th1|th2/ {print $1}'); do
  xwininfo -id "$id" | awk -v o="$OFF" -v v="$VAL" '/Width|Height/ {printf "%s ", $2} END{print " offset=" o " value=" v}'
done
