#!/usr/bin/env python3
"""th07(妖々夢)リプレイのヘッドレス録画パイプライン(Sattori ワーカー)。

touhou-recorder の PoC スクリプト
(scripts/11_record_th07_replay_e2e.py, reports/11・13・14) を Web サービス向けに
刷新したもの。PoC からの主な変更点は「録画対象リプレイを固定ファイル名ではなく
任意パスから受け取り、ゲームが認識する正規スロット名で配置する」点。

録画開始タイミング:
  ffmpeg の x11grab は録画対象領域内でウィンドウが作成/再作成されると以降が
  重複フレームだらけになるため、MOD ログの "WaitForStableWindow: stable"
  (ウィンドウ再作成が収まった時点) を確認してから録画を開始する(reports/12・13)。

再生終了検知:
  直前フレームとの差分(グレースケール縮小後の MAD)が閾値未満の状態が既定回数
  連続したら終了と判定する。閾値は霧背景等の低変化区間での誤検知を避けるため
  2.0(reports/14)。フェイルセーフに 40 分タイムアウトを併用する。
"""
import argparse
import io
import os
import signal
import subprocess
import sys
import time

import numpy as np
from PIL import Image

REPO = os.path.dirname(os.path.abspath(__file__))

DISPLAY = os.environ.get("SATTORI_DISPLAY", ":97")
XVFB_SCREEN = "800x600x24"
WINEPREFIX = os.environ.get("WINEPREFIX", f"{REPO}/prefixes/th07-wined3d-gl")
INSTANCE_DIR = os.environ.get("SATTORI_INSTANCE_DIR", f"{REPO}/instances/th07-recording")
GAME_DIR_SRC = os.environ.get("SATTORI_GAME_DIR", f"{REPO}/games/th07")
MOD_DIR = os.environ.get("SATTORI_MOD_DIR", f"{REPO}/mods")
INJECTOR = "injector.exe"
GAME_EXE = "th07.exe"
HOOK_DLL = "th07_hook.dll"
LOG_PATH = f"{INSTANCE_DIR}/th07_autoplay.log"
PULSE_SOURCE = "auto_null.monitor"

# th07 のリプレイ一覧で 1 件目に並ぶ正規スロット名。MOD は「1 件目のリプレイを
# 固定選択」するため、アップロードされた任意ファイル名をこの名前で配置することで
# 任意のリプレイを再生できる(MOD 自体の改修は不要)。
CANONICAL_SLOT = "th7_01.rpy"

# 閾値・待機の定数は PoC (reports/13・14) の実測に基づく。変更する場合は当該
# レポートの根拠を必ず確認すること。
STILL_MAD_THRESHOLD = 2.0
STILL_CONSECUTIVE_REQUIRED = 8  # 8 * POLL_INTERVAL_SEC = 16秒
POLL_INTERVAL_SEC = 2.0
POST_START_GRACE_SEC = 15.0
TIMEOUT_SEC = 40 * 60

env = os.environ.copy()
env["WINEPREFIX"] = WINEPREFIX
env["DISPLAY"] = DISPLAY
# 日本語ロケールを明示しないと動的描画の日本語が文字化けする(reports/13)。
env["LANG"] = "ja_JP.UTF-8"
env["LC_ALL"] = "ja_JP.UTF-8"


def log(msg):
    print(f"[record {time.strftime('%H:%M:%S')}] {msg}", flush=True)


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


def prepare_instance(replay_path):
    """ゲーム一式を instance ディレクトリへ複製し、録画対象リプレイだけを
    正規スロット名で replay/ 配下に配置する。"""
    subprocess.run(
        ["rsync", "-a", "--exclude=replay", f"{GAME_DIR_SRC}/", f"{INSTANCE_DIR}/"], check=True
    )
    replay_dir = f"{INSTANCE_DIR}/replay"
    os.makedirs(replay_dir, exist_ok=True)
    for f in os.listdir(replay_dir):
        os.remove(f"{replay_dir}/{f}")
    subprocess.run(["cp", replay_path, f"{replay_dir}/{CANONICAL_SLOT}"], check=True)
    subprocess.run(["cp", f"{MOD_DIR}/common/build/{INJECTOR}", INSTANCE_DIR], check=True)
    subprocess.run(
        ["cp", f"{MOD_DIR}/th07_replay_autoplay/build/{HOOK_DLL}", INSTANCE_DIR], check=True
    )
    if os.path.exists(LOG_PATH):
        os.remove(LOG_PATH)
    log(f"instance 準備完了 (対象リプレイを {CANONICAL_SLOT} として配置)")


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
            # クロップ座標は xwininfo の Absolute upper-left を使う
            # (xdotool getwindowgeometry だとタイトルバー分ズレる, AGENTS.md)。
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


def grab_frame(x, y, w, h):
    cmd = [
        "ffmpeg", "-y", "-f", "x11grab", "-draw_mouse", "0", "-video_size", f"{w}x{h}",
        "-i", f"{DISPLAY}+{x},{y}", "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-",
    ]
    result = subprocess.run(cmd, env=env, capture_output=True)
    img = Image.open(io.BytesIO(result.stdout)).convert("L").resize((160, 120))
    return np.asarray(img, dtype=np.float32)


def mad(a, b):
    return float(np.mean(np.abs(a - b)))


def build_ffmpeg_cmd(x, y, w, h, output, watermark_path, watermark_width):
    cmd = [
        "ffmpeg", "-y",
        "-f", "x11grab", "-draw_mouse", "0", "-video_size", f"{w}x{h}", "-framerate", "60",
        "-i", f"{DISPLAY}+{x},{y}",
        "-f", "pulse", "-i", PULSE_SOURCE,
    ]
    if watermark_path:
        # ウォーターマーク webm の VP9 アルファは libvpx 経由デコーダでないと
        # 不透明扱いになる(reports/18)。-c:v libvpx-vp9 を明示する。
        wm_w = min(watermark_width, w // 2)
        cmd += ["-c:v", "libvpx-vp9", "-i", watermark_path]
        cmd += [
            "-filter_complex",
            f"[2:v]scale={wm_w}:-1[wm];[0:v][wm]overlay=x=W-w-8:y=H-h-8:eof_action=pass[v]",
            "-map", "[v]", "-map", "1:a",
        ]
    cmd += [
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k",
        output,
    ]
    return cmd


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--replay-path", required=True, help="録画対象リプレイの絶対パス(任意ファイル名)")
    parser.add_argument("--output", required=True, help="出力する mp4 のパス")
    parser.add_argument("--watermark", default=None, help="ウォーターマーク動画(webm, VP9アルファ)のパス。未指定なら合成しない")
    parser.add_argument("--watermark-width", type=int, default=285)
    args = parser.parse_args()

    os.makedirs(os.path.dirname(args.output), exist_ok=True)

    ensure_xvfb()
    prepare_instance(args.replay_path)

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
    log("ウィンドウの安定を確認しました。録画を開始します")

    ffmpeg_cmd = build_ffmpeg_cmd(x, y, w, h, args.output, args.watermark, args.watermark_width)
    log(f"録画開始: {' '.join(ffmpeg_cmd)}")
    ffmpeg_log_path = f"{os.path.dirname(args.output)}/ffmpeg.log"
    ffmpeg_log_file = open(ffmpeg_log_path, "wb")
    record_proc = subprocess.Popen(
        ffmpeg_cmd, env=env,
        stdin=subprocess.PIPE, stdout=ffmpeg_log_file, stderr=subprocess.STDOUT,
    )
    record_start = time.time()

    sequence_complete_time = wait_for_log_marker(
        "sequence complete", timeout=20, poll_interval=0.1,
        log_all=True, seen_lines=seen_lines,
    )
    if sequence_complete_time is None:
        log("WARNING: MOD のキーシーケンス完了ログが検出できませんでした")
        sequence_complete_time = time.time()

    gameplay_start = sequence_complete_time
    log(f"リプレイ再生開始とみなす時刻から監視開始(猶予{POST_START_GRACE_SEC}秒)")

    prev_frame = None
    consecutive_still = 0
    detected = False
    while True:
        elapsed = time.time() - gameplay_start
        if elapsed > TIMEOUT_SEC:
            log(f"TIMEOUT: {TIMEOUT_SEC}秒経過したため強制停止します")
            break
        if elapsed < POST_START_GRACE_SEC:
            time.sleep(POLL_INTERVAL_SEC)
            continue

        frame = grab_frame(x, y, w, h)
        if prev_frame is not None:
            d = mad(prev_frame, frame)
            if d < STILL_MAD_THRESHOLD:
                consecutive_still += 1
            else:
                consecutive_still = 0
            log(f"poll: elapsed={elapsed:.1f}s MAD={d:.2f} still={consecutive_still}")
            if consecutive_still >= STILL_CONSECUTIVE_REQUIRED:
                log("画面が一定時間変化しなくなったためリプレイ終了と判定しました")
                detected = True
                break
        prev_frame = frame
        time.sleep(POLL_INTERVAL_SEC)

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

    subprocess.run(["pkill", "-9", "-x", GAME_EXE])
    subprocess.run(["wineserver", "-k"], env=env)

    total = time.time() - record_start
    log(f"録画終了。総録画時間 {total:.1f}秒 検知方式: {'画面静止' if detected else 'タイムアウト'}")

    if not os.path.exists(args.output):
        log(f"ERROR: 出力ファイルが生成されませんでした: {args.output}")
        sys.exit(1)
    log(f"出力ファイル: {args.output} ({os.path.getsize(args.output)} bytes)")


if __name__ == "__main__":
    main()
