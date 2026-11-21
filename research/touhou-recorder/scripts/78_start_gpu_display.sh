#!/usr/bin/env bash
# GPU描画が有効なヘッドレスX画面を用意する(フェーズ78)。
#
# 既存8タイトルは Xvfb + wined3d(OpenGL) + llvmpipe(ソフトウェア描画)で60fpsが
# 出ていたが、th06nc(東方紅魔郷: New Classic)はllvmpipeでは1280x720で9fps程度しか
# 出ず、録画に耐えない(reports/78)。Xvfbは DRI3 拡張を持たないためハードウェア描画を
# 使えないので、代わりに
#
#   headless backend の weston(--renderer=gl でGPUを使う)
#     └ rootful Xwayland(ルートウィンドウを持つ通常のX画面として振る舞う)
#         └ openbox
#
# という構成を立てる。rootfulにするのが要点で、westonが --xwayland で自動起動する
# rootless な Xwayland ではルートウィンドウに描画内容がcompositeされず、
# ffmpeg -f x11grab が真っ黒な画像しか取れない(reports/78 §6.1)。
#
# 【NVIDIA環境(AWS g6f等)ではこの構成は使えない】NVIDIAプロプライエタリドライバでは
# Xwayland上のGLがllvmpipeにフォールバックしてしまう(フェーズ80実測)。NVIDIAの場合は
# 代わりに Xorg + nvidia ドライバ(AllowEmptyInitialConfiguration)でヘッドレスX画面を
# 直接立てる。--backend auto(既定)が nvidia-smi の有無で自動選択する。
#
# Usage: scripts/78_start_gpu_display.sh [--display :2] [--screen 2200x1400]
#                                        [--backend auto|xorg|weston] [--stop]
#
# 起動後は通常のXvfb同様に DISPLAY=:2 で xwininfo / xdotool / ffmpeg が使える。

set -uo pipefail

DISPLAY_NUM="${GPU_DISPLAY:-:2}"
SCREEN="${GPU_SCREEN:-2200x1400}"
RUNTIME_DIR="${GPU_XDG_RUNTIME_DIR:-/tmp/wl-touhou-gpu}"
WL_SOCKET="${GPU_WL_SOCKET:-wl-touhou-gpu}"
STOP=0
BACKEND="${GPU_BACKEND:-auto}"
# xorgバックエンドで、仮想画面(--screen)とは別に「プライマリ出力の表示モード」を
# 明示したい場合に指定する(例: 1920x1080)。
#
# 【なぜ必要か】Xorg+nvidiaで Virtual 2200 1400 の画面を作ると、仮想画面は
# 2200x1400 になるが **CRTCの実モードは 1024x768 のまま**になる。th06ncは
# 「プライマリモニタの現在のモード」を見てウィンドウ解像度の選択肢を制限するため、
# この状態では th06.env で 1920x1080 を指定しても 1024x768 に落ちる
# (フェーズ81で実測。Xvfb上では画面サイズ=モードなので問題にならなかった)。
CRTC_MODE="${GPU_CRTC_MODE:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --display) DISPLAY_NUM="$2"; shift 2 ;;
    --screen) SCREEN="$2"; shift 2 ;;
    --backend) BACKEND="$2"; shift 2 ;;
    --crtc-mode) CRTC_MODE="$2"; shift 2 ;;
    --stop) STOP=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

# auto: NVIDIAドライバが生きていれば xorg、それ以外(amdgpu等)は weston+Xwayland。
if [[ "$BACKEND" == "auto" ]]; then
  if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1; then
    BACKEND=xorg
  else
    BACKEND=weston
  fi
fi

XORG_CONF="/etc/X11/xorg-touhou${DISPLAY_NUM#:}.conf"

WIDTH="${SCREEN%x*}"
HEIGHT="${SCREEN#*x}"

kill_matching() {
  # pkill -f は自分自身のコマンドラインにもマッチして自滅しうる(AGENTS.md)。
  # ps + kill -9 でPIDを明示する。
  local pattern="$1"
  local pids
  pids=$(ps -eo pid,args | grep -- "$pattern" | grep -v grep | awk '{print $1}')
  # Xorg(xorgバックエンド)はroot権限で起動しているので、ユーザー権限のkillでは
  # 落とせない。失敗したらsudoで落とす。
  for p in $pids; do kill -9 "$p" 2>/dev/null || sudo kill -9 "$p" 2>/dev/null; done
}

if [[ "$STOP" -eq 1 ]]; then
  # 実体は /usr/lib/xorg/Xorg なので "X :88" では一致しない。
  # "-config" までを含む共通部分で拾う。
  kill_matching "$DISPLAY_NUM -config"
  kill_matching "Xwayland $DISPLAY_NUM"
  kill_matching "weston .*--socket=$WL_SOCKET"
  # kill -9 ではソケットファイルが残るため明示的に削除する。残したままだと
  # 次回起動時に「weston は起動済み」と誤判定してXwaylandの接続だけが失敗する。
  rm -f "$RUNTIME_DIR/$WL_SOCKET" "$RUNTIME_DIR/$WL_SOCKET.lock"
  echo "停止しました($DISPLAY_NUM / $WL_SOCKET)" >&2
  exit 0
fi

if DISPLAY="$DISPLAY_NUM" timeout 5 xdpyinfo >/dev/null 2>&1; then
  echo "$DISPLAY_NUM は既に起動しています" >&2
  exit 0
fi

if [[ "$BACKEND" == "xorg" ]]; then
  # ---- NVIDIA: Xorg + nvidia ドライバでヘッドレスX画面を立てる ----
  # 要点:
  #  * BusIDは nvidia-xconfig --query-gpu-info から取る(インスタンスにより変わる)
  #  * AllowEmptyInitialConfiguration が無いと「no screens found」で落ちる
  #  * vGPU(g6f等のL4分割インスタンス)は仮想ディスプレイを持つため
  #    Option "UseDisplayDevice" "none" を付けてはいけない
  #    (`UseDisplayDevice "None" is not supported with virtual display` で落ちる)
  #  * Xorgの起動にはroot権限が必要
  if ! command -v nvidia-xconfig >/dev/null 2>&1; then
    echo "ERROR: nvidia-xconfig が見つかりません。NVIDIAドライバが未導入の可能性があります" >&2
    exit 1
  fi
  BUSID=$(nvidia-xconfig --query-gpu-info 2>/dev/null | grep -m1 "PCI BusID" | awk '{print $4}')
  if [[ -z "$BUSID" ]]; then
    # ドライババージョン・vGPU環境によっては --query-gpu-info 自体が
    # "ERROR: Unable to query GPU information" で失敗することがある(フェーズ82、
    # th15のg6f.2xlarge実機で確認、595.91.07)。nvidia-smiのPCIアドレス
    # (16進、例: 00000000:31:00.0)からXorg形式のBusID(10進、"PCI:49:0:0")を
    # 組み立てるフォールバックを用意する。
    PCI_HEX=$(nvidia-smi --query-gpu=pci.bus_id --format=csv,noheader 2>/dev/null | head -1)
    if [[ -n "$PCI_HEX" ]]; then
      BUS_HEX=$(echo "$PCI_HEX" | cut -d: -f2)
      DEV_HEX=$(echo "$PCI_HEX" | cut -d: -f3 | cut -d. -f1)
      FUNC_HEX=$(echo "$PCI_HEX" | cut -d. -f2)
      BUSID="PCI:$((16#$BUS_HEX)):$((16#$DEV_HEX)):$((16#$FUNC_HEX))"
      echo "nvidia-xconfig --query-gpu-info が失敗したため、nvidia-smi(pci.bus_id=$PCI_HEX)からBusIDを算出しました" >&2
    fi
  fi
  if [[ -z "$BUSID" ]]; then
    echo "ERROR: GPUのPCI BusIDを取得できませんでした(nvidia-smi は動作していますか?)" >&2
    exit 1
  fi
  echo "Xorg(nvidia, BusID=$BUSID, ${WIDTH}x${HEIGHT})で $DISPLAY_NUM を起動します" >&2
  sudo tee "$XORG_CONF" >/dev/null <<EOF
Section "ServerLayout"
    Identifier "Layout0"
    Screen 0 "Screen0"
EndSection
Section "Device"
    Identifier "Device0"
    Driver "nvidia"
    BusID "$BUSID"
    Option "AllowEmptyInitialConfiguration" "true"
    Option "ModeValidation" "AllowNonEdidModes, NoVesaModes"
EndSection
Section "Screen"
    Identifier "Screen0"
    Device "Device0"
    DefaultDepth 24
    SubSection "Display"
        Depth 24
        Virtual $WIDTH $HEIGHT
    EndSubSection
EndSection
EOF
  sudo rm -f "/tmp/.X11-unix/X${DISPLAY_NUM#:}" "/tmp/.X${DISPLAY_NUM#:}-lock"
  sudo setsid nohup X "$DISPLAY_NUM" -config "$XORG_CONF" -noreset \
      > "/tmp/xorg$DISPLAY_NUM.log" 2>&1 &
  for _ in $(seq 1 40); do
    DISPLAY="$DISPLAY_NUM" timeout 2 xdpyinfo >/dev/null 2>&1 && break
    sleep 0.25
  done
  if ! DISPLAY="$DISPLAY_NUM" timeout 5 xdpyinfo >/dev/null 2>&1; then
    echo "ERROR: Xorg $DISPLAY_NUM が起動しませんでした。/var/log/Xorg${DISPLAY_NUM#:}.log を確認してください" >&2
    sudo grep -m10 "(EE)" "/var/log/Xorg${DISPLAY_NUM#:}.log" >&2 2>/dev/null
    exit 1
  fi

  if [[ -n "$CRTC_MODE" ]]; then
    output=$(DISPLAY="$DISPLAY_NUM" xrandr 2>/dev/null | awk '/ connected/{print $1; exit}')
    if [[ -z "$output" ]]; then
      echo "WARNING: xrandrの出力名を取得できませんでした。CRTCモードの設定をスキップします" >&2
    elif DISPLAY="$DISPLAY_NUM" xrandr --output "$output" --mode "$CRTC_MODE" 2>/dev/null; then
      echo "CRTCモードを $output $CRTC_MODE に設定しました" >&2
    else
      echo "WARNING: CRTCモード $CRTC_MODE を設定できませんでした(利用可能なモードを確認してください)" >&2
    fi
  fi

  # 注意: openboxの設定で全ウィンドウを装飾なし・(0,0)固定にする案は逆効果だった
  # (WineがWin32のタイトルバー領域を自前で確保し、クライアント領域がX窓の内側で(3,29)
  # ずれる。xdotoolは(0,0)を返すため検知できない。reports/89)。既定のまま起動し、
  # 録画中のずれは recorder/window.py の start_origin_guard() で戻す。
  DISPLAY="$DISPLAY_NUM" setsid nohup openbox --sm-disable > /tmp/openbox$DISPLAY_NUM.log 2>&1 &
  sleep 1

  renderer=$(DISPLAY="$DISPLAY_NUM" timeout 15 glxinfo 2>/dev/null | grep -m1 "OpenGL renderer")
  echo "$DISPLAY_NUM 準備完了: $renderer" >&2
  if echo "$renderer" | grep -qi llvmpipe; then
    echo "WARNING: ソフトウェア描画(llvmpipe)になっています。GPUが使われていません" >&2
    exit 1
  fi
  exit 0
fi

mkdir -p "$RUNTIME_DIR"
chmod 700 "$RUNTIME_DIR"
export XDG_RUNTIME_DIR="$RUNTIME_DIR"

# ソケットファイルの有無ではなく weston プロセスの生死で判定する
# (kill -9 された後もソケットファイルは残るため)。
if ! ps -eo args | grep -q -- "[w]eston .*--socket=$WL_SOCKET"; then
  echo "headless weston を起動します(socket=$WL_SOCKET, ${WIDTH}x${HEIGHT})" >&2
  rm -f "$RUNTIME_DIR/$WL_SOCKET" "$RUNTIME_DIR/$WL_SOCKET.lock"
  # --renderer=gl が必須。既定の pixman はソフトウェア描画になる。
  # setsid でプロセスグループを切り離す。付けないと起動元シェルが終了・kill された
  # ときに weston/Xwayland/openbox も道連れになる。
  setsid nohup weston --backend=headless --width="$WIDTH" --height="$HEIGHT" \
      --socket="$WL_SOCKET" --renderer=gl > /tmp/weston-$WL_SOCKET.log 2>&1 &
  for _ in $(seq 1 40); do
    [[ -S "$RUNTIME_DIR/$WL_SOCKET" ]] && break
    sleep 0.25
  done
  if ! grep -q "Using GL renderer" /tmp/weston-$WL_SOCKET.log; then
    echo "ERROR: weston が GL renderer で起動していません。/tmp/weston-$WL_SOCKET.log を確認してください" >&2
    exit 1
  fi
  grep -m1 "GL renderer:" /tmp/weston-$WL_SOCKET.log >&2
fi

rm -f "/tmp/.X11-unix/X${DISPLAY_NUM#:}" "/tmp/.X${DISPLAY_NUM#:}-lock"
echo "rootful Xwayland $DISPLAY_NUM を起動します" >&2
WAYLAND_DISPLAY="$WL_SOCKET" setsid nohup Xwayland "$DISPLAY_NUM" \
    -geometry "${WIDTH}x${HEIGHT}" -noreset > /tmp/xwayland$DISPLAY_NUM.log 2>&1 &
for _ in $(seq 1 20); do
  DISPLAY="$DISPLAY_NUM" timeout 2 xdpyinfo >/dev/null 2>&1 && break
  sleep 0.25
done
if ! DISPLAY="$DISPLAY_NUM" timeout 5 xdpyinfo >/dev/null 2>&1; then
  echo "ERROR: Xwayland $DISPLAY_NUM が起動しませんでした" >&2
  exit 1
fi

DISPLAY="$DISPLAY_NUM" setsid nohup openbox --sm-disable > /tmp/openbox$DISPLAY_NUM.log 2>&1 &
sleep 1

renderer=$(DISPLAY="$DISPLAY_NUM" timeout 15 glxinfo 2>/dev/null | grep -m1 "OpenGL renderer")
echo "$DISPLAY_NUM 準備完了: $renderer" >&2
if echo "$renderer" | grep -qi llvmpipe; then
  echo "WARNING: ソフトウェア描画(llvmpipe)になっています。GPUが使われていません" >&2
  exit 1
fi
