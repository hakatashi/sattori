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
import glob
import os
import subprocess
import time


def _parse_pci_bus_id(raw_str):
    """PCI BusID文字列 (例: '00000000:31:00.0', '0000:31:00.0', 'PCI:49:0:0') を
    Xorg設定で使える 'PCI:bus:device:function' (またはドメイン付き 'PCI:bus@domain:device:function')
    形式へ正規化する。
    パースできなければNone。"""
    if not raw_str:
        return None
    raw_str = raw_str.strip()
    if not raw_str:
        return None

    # 既に 'PCI:...' 形式の場合 (例: nvidia-xconfig の出力)
    if raw_str.startswith("PCI:"):
        return raw_str

    # '00000000:31:00.0' または '0000:31:00.0' の形式
    # ドメイン:バス:デバイス.ファンクション (16進数)
    try:
        domain_bus_dev, dot, func_hex = raw_str.partition(".")
        if not dot:
            return None
        parts = domain_bus_dev.split(":")
        if len(parts) == 3:
            domain_hex, bus_hex, dev_hex = parts
        elif len(parts) == 2:
            domain_hex = "0"
            bus_hex, dev_hex = parts
        else:
            return None

        domain = int(domain_hex, 16)
        bus = int(bus_hex, 16)
        dev = int(dev_hex, 16)
        func = int(func_hex, 16)

        if domain == 0:
            return f"PCI:{bus}:{dev}:{func}"
        return f"PCI:{bus}@{domain}:{dev}:{func}"
    except ValueError:
        return None


def _query_bus_id(env):
    """GPUのBusIDを取得する。
    1. nvidia-smi --query-gpu=pci.bus_id
    2. nvidia-xconfig --query-gpu-info
    3. /proc/driver/nvidia/gpus/ 配下のディレクトリ名
    4. /sys/bus/pci/drivers/nvidia/ 配下のシンボリックリンク名
    の順に試行する。
    取得できなければNone。"""
    # 1. nvidia-smi (コンテナ内・nvidia-container-toolkit経由で最も確実に利用可能)
    try:
        result = subprocess.run(
            ["nvidia-smi", "--query-gpu=pci.bus_id", "--format=csv,noheader"],
            env=env, capture_output=True, text=True,
        )
        if result.returncode == 0:
            for line in result.stdout.splitlines():
                parsed = _parse_pci_bus_id(line)
                if parsed:
                    return parsed
    except Exception:
        pass

    # 2. nvidia-xconfig (ホスト環境等)
    try:
        result = subprocess.run(
            ["nvidia-xconfig", "--query-gpu-info"], env=env, capture_output=True, text=True,
        )
        if result.returncode == 0:
            for line in result.stdout.splitlines():
                line = line.strip()
                if line.startswith("PCI BusID"):
                    _label, _sep, value = line.partition(":")
                    parsed = _parse_pci_bus_id(value.strip().lstrip(":").strip())
                    if parsed:
                        return parsed
    except Exception:
        pass

    # 3. /proc/driver/nvidia/gpus/ (Linux procfs)
    proc_gpu_dirs = glob.glob("/proc/driver/nvidia/gpus/*")
    for d in proc_gpu_dirs:
        parsed = _parse_pci_bus_id(os.path.basename(d))
        if parsed:
            return parsed

    # 4. /sys/bus/pci/drivers/nvidia/ (Linux sysfs)
    sys_pci_entries = glob.glob("/sys/bus/pci/drivers/nvidia/0000:*") + glob.glob("/sys/bus/pci/drivers/nvidia/00000000:*")
    for entry in sys_pci_entries:
        parsed = _parse_pci_bus_id(os.path.basename(entry))
        if parsed:
            return parsed

    return None


def _build_xorg_config(bus_id, screen_wh):
    """ヘッドレスNVIDIA用のXorg設定。`UseDisplayDevice`は意図的に付けない
    (vGPUでは`Failed to select a display subsystem`になる、ファイル冒頭の説明参照)。"""
    screen_w, screen_h = screen_wh.split("x")
    return f"""Section "ServerLayout"
    Identifier "Layout0"
    Screen 0 "Screen0"
EndSection

Section "Device"
    Identifier "Device0"
    Driver "nvidia"
    BusID "{bus_id}"
    Option "AllowEmptyInitialConfiguration" "true"
    Option "ModeValidation" "AllowNonEdidModes, NoVesaModes"
EndSection

Section "Screen"
    Identifier "Screen0"
    Device "Device0"
    DefaultDepth 24
    SubSection "Display"
        Depth 24
        Virtual {screen_w} {screen_h}
    EndSubSection
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

    既に起動済みなら再利用する(`ensure_xvfb()`と同じ判定手法、xdpyinfoでの
    ディスプレイ接続が成功するかどうかを見る)。未起動の場合はBusIDを動的解決して
    Xorg設定ファイルを生成し、Xorg起動 -> openbox起動 -> (crtc_mode指定時)
    xrandrでCRTCモード変更、の順に行う。
    """
    check = subprocess.run(["xdpyinfo"], env=env, capture_output=True)
    if check.returncode == 0:
        log(f"GPU描画面 {config.display} は起動済みとみなして再利用します")
        return

    bus_id = _query_bus_id(env)
    if not bus_id:
        raise RuntimeError(
            "nvidia-smi / nvidia-xconfig からBusIDを取得できませんでした"
            "(GPU用カスタムAMI・ドライバ導入を確認すること)"
        )
    log(f"GPU BusID: {bus_id}")

    screen_w, screen_h, _depth = config.xvfb_screen.split("x")
    disp_num = config.display.lstrip(":")
    xorg_conf_path = f"/tmp/xorg-{disp_num}.conf"
    xorg_log_path = f"/tmp/xorg-{disp_num}.log"
    with open(xorg_conf_path, "w") as f:
        f.write(_build_xorg_config(bus_id, f"{screen_w}x{screen_h}"))

    # 古いロックファイルやソケットの掃除
    for lock_file in [f"/tmp/.X11-unix/X{disp_num}", f"/tmp/.X{disp_num}-lock"]:
        try:
            if os.path.exists(lock_file):
                os.remove(lock_file)
        except OSError:
            pass

    log(f"Xorg {config.display} を起動します (screen={config.xvfb_screen}, config={xorg_conf_path})")
    xorg_log_file = open(xorg_log_path, "wb")
    xorg_proc = subprocess.Popen(
        ["Xorg", config.display, "-config", xorg_conf_path, "-noreset", "-logfile", xorg_log_path],
        env=env, stdout=xorg_log_file, stderr=subprocess.STDOUT,
    )

    # Xorgの起動完了を待機
    xorg_ok = False
    for _ in range(40):
        if xorg_proc.poll() is not None:
            break
        check = subprocess.run(["xdpyinfo"], env=env, capture_output=True)
        if check.returncode == 0:
            xorg_ok = True
            break
        time.sleep(0.25)

    if not xorg_ok:
        xorg_log_file.close()
        log_content = ""
        candidate_logs = [
            xorg_log_path,
            f"/var/log/Xorg.{disp_num}.log",
            f"/var/log/Xorg.0.log",
        ]
        for path in candidate_logs:
            if os.path.exists(path):
                try:
                    with open(path, "r", errors="replace") as f:
                        log_content = f.read()
                    if log_content.strip():
                        break
                except Exception:
                    pass
        raise RuntimeError(
            f"Xorg {config.display} の起動に失敗しました (exit_code={xorg_proc.poll()})。\n"
            f"--- Xorg Log ---\n{log_content[-3000:]}"
        )

    log(f"Xorg {config.display} の起動を確認しました")

    subprocess.Popen(
        ["openbox", "--sm-disable"], env=env,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    time.sleep(1.0)

    # OpenGL / Vulkan の診断ログ
    try:
        glx = subprocess.run(["glxinfo", "-B"], env=env, capture_output=True, text=True)
        if glx.returncode == 0:
            for line in glx.stdout.splitlines():
                log(f"[gpu_display:glx] {line.strip()}")
        else:
            log(f"[gpu_display:glx] glxinfo -B 失敗 (exit={glx.returncode}): {glx.stderr.strip()[:500]}")
    except Exception as e:
        log(f"[gpu_display:glx] glxinfo 実行例外: {e}")

    try:
        vk = subprocess.run(["vulkaninfo", "--summary"], env=env, capture_output=True, text=True)
        log(f"[gpu_display:vk] vulkaninfo --summary exit={vk.returncode}")
        if vk.stdout.strip():
            for line in vk.stdout.splitlines():
                if any(k in line for k in ("deviceName", "driverInfo", "apiVersion", "driverVersion", "ERROR", "WARNING")):
                    log(f"[gpu_display:vk] {line.strip()}")
        if vk.stderr.strip():
            for line in vk.stderr.splitlines()[:20]:
                log(f"[gpu_display:vk:stderr] {line.strip()}")
    except Exception as e:
        log(f"[gpu_display:vk] vulkaninfo 実行例外: {e}")

    # Vulkan ICD / ドライバファイルの診断
    icd_files = glob.glob("/etc/vulkan/icd.d/*.json") + glob.glob("/usr/share/vulkan/icd.d/*.json")
    log(f"[gpu_display] 検出された Vulkan ICD ファイル: {icd_files}")
    for icd_path in icd_files:
        try:
            with open(icd_path, "r") as f:
                log(f"[gpu_display] ICD {icd_path}: {f.read().strip()}")
        except Exception as e:
            log(f"[gpu_display] ICD {icd_path} 読み取り失敗: {e}")

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

