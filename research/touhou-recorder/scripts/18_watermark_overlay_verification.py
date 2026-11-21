#!/usr/bin/env python3
"""ウォーターマーク合成の実機検証用スクリプト。

scripts/11_record_th07_replay_e2e.py をベースに、録画開始直後にffmpegの
filter_complexでウォーターマーク動画(webm, VP9アルファ付き)を右下に
overlay合成する点のみを変更したもの。リプレイ終了検知は行わず、
録画開始から一定秒数(--duration)で強制停止する短時間検証専用。

ウォーターマークのVP9アルファはffmpegのデフォルト(ネイティブ)デコーダでは
マージされず常に不透明として扱われてしまうため、`-c:v libvpx-vp9`で
明示的にlibvpx経由のデコーダを指定する必要がある(要検証事項として発見)。
"""
import argparse
import os
import signal
import subprocess
import sys
import time

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

DISPLAY = ":97"
XVFB_SCREEN = "800x600x24"
WINEPREFIX = f"{REPO}/prefixes/th07-wined3d-gl"
INSTANCE_DIR = f"{REPO}/instances/th07-recording-test"
GAME_DIR_SRC = f"{REPO}/games/th07"
INJECTOR = "injector.exe"
GAME_EXE = "th07.exe"
HOOK_DLL = "th07_hook.dll"
LOG_PATH = f"{INSTANCE_DIR}/th07_autoplay.log"
PULSE_SOURCE = "auto_null.monitor"
WATERMARK_PATH = "/home/hakatashi/Documents/GitHub/agent-playgrounds/watermark-webm-export/output/watermark-60fps.webm"

env = os.environ.copy()
env["WINEPREFIX"] = WINEPREFIX
env["DISPLAY"] = DISPLAY
env["LANG"] = "ja_JP.UTF-8"
env["LC_ALL"] = "ja_JP.UTF-8"


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def ensure_xvfb():
    check = subprocess.run(["xdotool", "search", "--name", "."], env=env, capture_output=True)
    if check.returncode == 0:
        log(f"Xvfb {DISPLAY} は起動済みとみなして再利用します")
        return
    log(f"Xvfb {DISPLAY} を起動します")
    subprocess.Popen(
        ["Xvfb", DISPLAY, "-screen", "0", XVFB_SCREEN],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    time.sleep(1.5)
    subprocess.Popen(
        ["openbox", "--sm-disable"], env=env,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    time.sleep(1.0)


def prepare_instance(replay_filename):
    subprocess.run(
        ["rsync", "-a", "--exclude=replay", f"{GAME_DIR_SRC}/", f"{INSTANCE_DIR}/"], check=True
    )
    os.makedirs(f"{INSTANCE_DIR}/replay", exist_ok=True)
    for f in os.listdir(f"{INSTANCE_DIR}/replay"):
        os.remove(f"{INSTANCE_DIR}/replay/{f}")
    subprocess.run(
        ["cp", f"{GAME_DIR_SRC}/replay/{replay_filename}", f"{INSTANCE_DIR}/replay/"], check=True
    )
    subprocess.run(
        ["cp", f"{REPO}/mods/common/build/{INJECTOR}", INSTANCE_DIR], check=True
    )
    subprocess.run(
        ["cp", f"{REPO}/mods/th07_replay_autoplay/build/{HOOK_DLL}", INSTANCE_DIR], check=True
    )
    if os.path.exists(LOG_PATH):
        os.remove(LOG_PATH)
    log(f"instance ディレクトリ準備完了 (replay={replay_filename} のみ配置)")


def find_window(pid):
    out = subprocess.run(
        ["xdotool", "search", "--pid", str(pid)], env=env, capture_output=True, text=True
    ).stdout.split()
    for w in out:
        info = subprocess.run(["xwininfo", "-id", w], env=env, capture_output=True, text=True).stdout
        if "IsViewable" not in info:
            continue
        x = y = wd = ht = None
        for line in info.splitlines():
            line = line.strip()
            if line.startswith("Absolute upper-left X:"):
                x = int(line.split(":")[1])
            elif line.startswith("Absolute upper-left Y:"):
                y = int(line.split(":")[1])
            elif line.startswith("Width:"):
                wd = int(line.split(":")[1])
            elif line.startswith("Height:"):
                ht = int(line.split(":")[1])
        if wd and wd > 100 and ht and ht > 100:
            return x, y, wd, ht, w
    return None


def wait_for_log_marker(marker, timeout, poll_interval=0.1, log_all=False, seen_lines=None):
    if seen_lines is None:
        seen_lines = set()
    t0 = time.time()
    while time.time() - t0 < timeout:
        if os.path.exists(LOG_PATH):
            with open(LOG_PATH) as f:
                lines = f.readlines()
            for line in lines:
                if line in seen_lines:
                    continue
                seen_lines.add(line)
                if log_all:
                    log(f"MODログ: {line.strip()}")
                if marker in line:
                    return time.time()
        time.sleep(poll_interval)
    return None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--replay", default="th7_07.rpy")
    parser.add_argument("--output", default=f"{REPO}/runs/watermark_verification/video.mp4")
    parser.add_argument("--duration", type=float, default=25.0, help="録画開始からの強制停止秒数")
    parser.add_argument("--watermark-width", type=int, default=285, help="ウォーターマークのスケール後の横幅(px)")
    args = parser.parse_args()

    os.makedirs(os.path.dirname(args.output), exist_ok=True)

    ensure_xvfb()
    prepare_instance(args.replay)

    log("injector を起動します")
    subprocess.Popen(
        ["wine", INJECTOR, GAME_EXE, HOOK_DLL],
        cwd=INSTANCE_DIR, env=env,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )

    game_pid = None
    t0 = time.time()
    while time.time() - t0 < 20:
        out = subprocess.run(["pgrep", "-x", GAME_EXE], capture_output=True, text=True).stdout.split()
        if out:
            game_pid = out[0]
            break
        time.sleep(0.1)
    if not game_pid:
        log("ERROR: th07.exe プロセスが検出できませんでした")
        sys.exit(1)
    log(f"game_pid={game_pid} ({time.time()-t0:.1f}s)")

    geom = None
    t0 = time.time()
    while time.time() - t0 < 20:
        geom = find_window(game_pid)
        if geom:
            break
        time.sleep(0.1)
    if not geom:
        log("ERROR: ゲームウィンドウが検出できませんでした")
        sys.exit(1)
    x, y, w, h, winid = geom
    log(f"ウィンドウ検出: x={x} y={y} w={w} h={h} (winid={winid})")

    seen_lines = set()
    stable_time = wait_for_log_marker(
        "WaitForStableWindow: stable", timeout=20, poll_interval=0.1,
        log_all=True, seen_lines=seen_lines,
    )
    if stable_time is None:
        log("ERROR: ウィンドウの安定を確認できませんでした")
        sys.exit(1)
    log("ウィンドウの安定を確認しました。ウォーターマーク合成付き録画を開始します")

    watermark_w = min(args.watermark_width, w // 2)
    ffmpeg_cmd = [
        "ffmpeg", "-y",
        "-f", "x11grab", "-draw_mouse", "0", "-video_size", f"{w}x{h}", "-framerate", "60",
        "-i", f"{DISPLAY}+{x},{y}",
        "-f", "pulse", "-i", PULSE_SOURCE,
        "-c:v", "libvpx-vp9", "-i", WATERMARK_PATH,
        "-filter_complex",
        f"[2:v]scale={watermark_w}:-1[wm];[0:v][wm]overlay=x=W-w-8:y=H-h-8:eof_action=pass[v]",
        "-map", "[v]", "-map", "1:a",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k",
        args.output,
    ]
    log(f"録画開始: {' '.join(ffmpeg_cmd)}")
    ffmpeg_log_path = f"{os.path.dirname(args.output)}/ffmpeg.log"
    ffmpeg_log_file = open(ffmpeg_log_path, "wb")
    record_proc = subprocess.Popen(
        ffmpeg_cmd, env=env,
        stdin=subprocess.PIPE, stdout=ffmpeg_log_file, stderr=subprocess.STDOUT,
    )
    record_start = time.time()

    log(f"{args.duration}秒間録画してから強制停止します(検証用のためリプレイ終了検知は行わない)")
    time.sleep(args.duration)

    log("録画を停止します (SIGINT)")
    record_proc.send_signal(signal.SIGINT)
    try:
        record_proc.wait(timeout=20)
    except subprocess.TimeoutExpired:
        log("WARNING: ffmpeg が時間内に終了しなかったため terminate します")
        record_proc.terminate()
        record_proc.wait(timeout=10)
    ffmpeg_log_file.close()
    log(f"ffmpeg exit_code={record_proc.returncode}")
    if os.path.exists(args.output):
        log(f"出力ファイルサイズ: {os.path.getsize(args.output)} bytes")
    else:
        log(f"WARNING: 出力ファイルが見つかりません: {args.output}")
        with open(ffmpeg_log_path, "rb") as f:
            tail = f.read()[-4000:]
        log(f"ffmpegログ(末尾4000バイト): {tail.decode(errors='replace')}")

    total_record_sec = time.time() - record_start
    log(f"録画終了。総録画時間: {total_record_sec:.1f}秒")

    subprocess.run(["pkill", "-9", "-x", GAME_EXE])
    subprocess.run(["wineserver", "-k"], env=env)

    log(f"出力ファイル: {args.output}")


if __name__ == "__main__":
    main()
