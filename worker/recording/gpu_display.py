"""GPU描画(Xorg+NVIDIA GRIDドライバ)によるヘッドレス画面の初期化(Issue #241)。

th06nc(東方紅魔郷: New Classic)はD3D11描画であり、既存9タイトルが使う
Xvfb+wined3d+llvmpipe(ソフトウェア描画)では60fpsに遠く届かない(720pで9.1fps、
touhou-recorder reports/78)。GPU(NVIDIA GRIDドライバ)を使ったXorgのヘッドレス
画面上で、DXVK(D3D11→Vulkan、`GameConfig.dxvk_dll_overrides`)により描画する
ことで60fpsを達成する(reports/79〜81)。

## なぜ headless weston + Xwayland ではなく Xorg + nvidia なのか

ローカル検証環境(AMD Radeon VII)ではheadless weston(GLレンダラ) + rootful
Xwaylandの組み合わせでGPU描画面を作れた(reports/78)。しかしAWS実機
(NVIDIA L4、g6f.xlarge)では、weston自体はGPUを使えるのに、その上のXwaylandに
繋いだクライアントのOpenGLがllvmpipe(ソフトウェア描画)にフォールバックして
しまう問題が判明した(reports/81 §4)。**Xorg + nvidiaドライバでヘッドレス
X画面を直接立てる**ことで、クライアントも確実にGPUレンダラを使えるようになる。

## Xorg設定の要点(reports/81 §4)

- BusIDは決め打ちしない。`nvidia-xconfig --query-gpu-info`から取得する
  (実機ごとにPCIアドレスが変わりうるため)。
- `Option "AllowEmptyInitialConfiguration" "true"`が必須。無いと
  `(EE) no screens found`で起動に失敗する。
- `Option "UseDisplayDevice" "none"`を付けてはいけない。vGPU(g6f)は仮想
  ディスプレイを持つため、付けると
  `UseDisplayDevice "None" is not supported with virtual display`で落ちる
  (ヘッドレス用の定番設定として紹介されることが多いオプションだが、
  vGPU環境では逆効果になる)。

## 1080p録画時のCRTCモード切り替え(reports/81 §9.9.1)

Xorg+nvidia環境では「仮想画面サイズ(`config.xvfb_screen`)」と「CRTCの実モード」が
別概念で、th06ncはCRTCの実モードを見てウィンドウ解像度の選択肢(720p/1080p)を
決める。仮想画面はウィンドウ+装飾が収まる大きさのまま、CRTCモードだけを
`config.crtc_mode`(例: "1920x1080")へ`xrandr --output <出力名> --mode`で明示的に
切り替える必要がある。出力名は環境によって変わりうるため`xrandr --query`から
動的に取得する。

**実機未検証の注意**: `nvidia-xconfig --query-gpu-info`の出力パース
(`_query_bus_id()`)は、touhou-recorder reports/81での実行結果の記述に基づく
実装であり、AMI構築・実機検証(worker/docs/titles/th06nc.md参照)の過程で
出力フォーマットの差異が見つかった場合は調整が必要。
"""
import subprocess
import time


def _query_bus_id(env):
    """`nvidia-xconfig --query-gpu-info`の出力から`PCI BusID`の値を取得する。
    取得できなければNone。"""
    result = subprocess.run(
        ["nvidia-xconfig", "--query-gpu-info"], env=env, capture_output=True, text=True,
    )
    for line in result.stdout.splitlines():
        line = line.strip()
        if line.startswith("PCI BusID"):
            _label, _sep, value = line.partition(":")
            return value.strip().lstrip(":").strip() or None
    return None


def _build_xorg_config(bus_id, screen_wh):
    """ヘッドレスNVIDIA用のXorg設定。`UseDisplayDevice`は意図的に付けない
    (vGPUでは`Failed to select a display subsystem`になる、ファイル冒頭の説明参照)。"""
    return f"""Section "Device"
    Identifier "Card0"
    Driver "nvidia"
    BusID "{bus_id}"
    Option "AllowEmptyInitialConfiguration" "true"
EndSection

Section "Screen"
    Identifier "Screen0"
    Device "Card0"
    DefaultDepth 24
    SubSection "Display"
        Depth 24
        Modes "{screen_wh}"
    EndSubSection
EndSection

Section "ServerLayout"
    Identifier "Layout0"
    Screen 0 "Screen0"
EndSection
"""


def _primary_output_name(env):
    """`xrandr --query`から、接続済み出力の名前を1つ取得する。実機・ドライバ
    バージョンによって名前(DVI-D-0等)が変わりうるため決め打ちにしない。
    取得できなければNone。"""
    result = subprocess.run(["xrandr", "--query"], env=env, capture_output=True, text=True)
    for line in result.stdout.splitlines():
        if " connected" in line:
            return line.split()[0]
    return None


def ensure_gpu_display(config, env, log=print):
    """GPU描画必須タイトル用のヘッドレスX画面(Xorg+NVIDIA)を用意する
    (`recording.instance.ensure_display()`が`config.gpu_display`で本関数を選ぶ)。

    既に起動済みなら再利用する(`ensure_xvfb()`と同じ判定手法、xdotoolでの
    ウィンドウ列挙が成功するかどうかを見る)。未起動の場合はBusIDを動的解決して
    Xorg設定ファイルを生成し、Xorg起動 -> openbox起動 -> (crtc_mode指定時)
    xrandrでCRTCモード変更、の順に行う。
    """
    check = subprocess.run(["xdotool", "search", "--name", "."], env=env, capture_output=True)
    if check.returncode == 0:
        log(f"GPU描画面 {config.display} は起動済みとみなして再利用します")
        return

    bus_id = _query_bus_id(env)
    if not bus_id:
        raise RuntimeError(
            "nvidia-xconfig --query-gpu-info からBusIDを取得できませんでした"
            "(GPU用カスタムAMI・ドライバ導入を確認すること)"
        )
    log(f"GPU BusID: {bus_id}")

    screen_w, screen_h, _depth = config.xvfb_screen.split("x")
    xorg_conf_path = f"/tmp/xorg-{config.display.lstrip(':')}.conf"
    with open(xorg_conf_path, "w") as f:
        f.write(_build_xorg_config(bus_id, f"{screen_w}x{screen_h}"))

    log(f"Xorg {config.display} を起動します (screen={config.xvfb_screen}, config={xorg_conf_path})")
    subprocess.Popen(
        ["Xorg", config.display, "-config", xorg_conf_path],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    # Xvfbより起動が重い(GPU初期化を伴う)ため、ensure_xvfb()の1.5秒より長く待つ。
    time.sleep(3.0)

    subprocess.Popen(
        ["openbox", "--sm-disable"], env=env,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    time.sleep(1.0)

    if config.crtc_mode:
        output_name = _primary_output_name(env)
        if not output_name:
            log("WARNING: xrandrの出力名を取得できず、CRTCモードの変更をスキップします"
                "(1080p録画を指定していた場合、720pのまま起動する可能性があります)")
        else:
            log(f"xrandr --output {output_name} --mode {config.crtc_mode} を実行します")
            subprocess.run(
                ["xrandr", "--output", output_name, "--mode", config.crtc_mode], env=env,
            )
