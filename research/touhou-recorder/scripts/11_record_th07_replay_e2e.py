#!/usr/bin/env python3
"""th07(妖々夢)のリプレイファイルをXvfb+wine+ffmpegでヘッドレス録画し、
DLL MOD(mods/th07_replay_autoplay/)によるメニュー自動操作からリプレイ再生開始、
再生終了の自動検知・録画停止までを一気通貫で行う検証スクリプト。

録画開始タイミング:
  ffmpegのx11grab+libx264+pulseは、対象ウィンドウの作成/再作成イベントが
  録画中に発生すると、その後録画全体が重複フレームだらけになる(処理落ち
  したような映像になる)ことが実験で判明している(Python側のポーリング
  頻度や録画開始と並行するファイルアクセスの有無は無関係)。そのため、
  MODのログで"WaitForStableWindow: stable"(ウィンドウの再作成が完全に
  収まった時点)を確認してから録画を開始する。これによりタイトル画面
  (アトラクトモード)からメニュー自動操作・リプレイ本編まで一本の録画に
  含めることができる。詳細はreports/12・13を参照。

再生終了検知の方式:
  基準フレーム(リプレイ一覧画面等)との比較ではなく、直前にポーリングした
  フレームとの差分(グレースケールダウンサンプル後の平均絶対誤差)を毎回
  比較する方式。差分が閾値を下回る状態が既定回数連続したら「画面が変化
  しなくなった=リプレイ終了」と判定して録画を止める。基準フレームの
  撮影に失敗するリスクや、タイトル画面のレイアウトを事前に知っておく
  必要がない汎用的な方式。ステージ導入ダイアログ等でも最大9秒程度は
  画面が静止することを実測済みのため、猶予時間・連続判定回数はそれより
  十分大きく設定している。クリア時のエンディング演出等でも最終的に
  静止画面に落ち着けば検知できるが、念のためタイムアウト(既定40分)
  によるフェイルセーフも用意している。

  閾値についての注意:
  当初はMAD閾値10.0を採用していたが、th7_09.rpy(通常ステージ、総再生
  時間約30分)で誤検知が発生した。霧のかかった川の背景等、ゲームプレイ
  中(スコアは増加中)でも視覚的変化に乏しい区間ではMADが4〜9程度で
  30秒以上張り付くことがあり、閾値10.0では区別できなかったため。実際の
  リプレイ終了(一覧画面復帰)時はMADが0.0近辺に張り付くことを確認して
  いるため、閾値は2.0まで下げてマージンを確保している。
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

# 閾値10.0はth7_09.rpy(通常ステージ, 総再生時間約30分)で誤検知した。
# 霧のかかった川の背景など、実際にゲームプレイ中(スコアは増加し続けている)
# にもかかわらず視覚的な変化に乏しい区間で、2秒間隔のMADが4〜9程度に
# 長時間(30秒以上)張り付くケースが存在するため。reports/13で計測した
# 他ステージでのゲームプレイ中最小MAD(3.50)とも整合する。
# 一方、実際のリプレイ終了(一覧画面復帰)時はMADが0.0近辺に張り付く
# ことが確認されている(reports/13)ため、閾値をゲームプレイ中最小値より
# 十分低く、かつ静止画面比較時のエンコードノイズ(実測0.7程度)より
# 十分高い値まで下げてマージンを確保する。
STILL_MAD_THRESHOLD = 2.0
STILL_CONSECUTIVE_REQUIRED = 8  # 8 * POLL_INTERVAL_SEC = 16秒
POLL_INTERVAL_SEC = 2.0
POST_START_GRACE_SEC = 15.0
# 総再生時間30分前後のリプレイ(th7_09.rpy等)も余裕を持って録り切れるよう、
# 従来の22分から40分に拡大(静止検知が万一機能しなかった場合のフェイルセーフ)。
TIMEOUT_SEC = 40 * 60

env = os.environ.copy()
env["WINEPREFIX"] = WINEPREFIX
env["DISPLAY"] = DISPLAY
# WINEPREFIXが英語(米国)ロケールで初期化されているとShift-JISのフォント名
# 指定がUnicodeへ正しく変換されず、動的描画される日本語テキストが文字化け
# し、結果としてMS Gothicではなくフォールバックフォントで描画されてしまう
# (reports/13参照)。日本語ロケールを明示することで解決する。
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
    """LOG_PATHに指定マーカーを含む行が現れるまで待つ。見つかった時刻(time.time())を返す(見つからなければNone)。"""
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


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--replay", default="th7_07.rpy")
    parser.add_argument("--output", default=f"{REPO}/runs/th07_full_replay_audio/video.mp4")
    parser.add_argument("--watermark", default=None, help="右下に合成するウォーターマーク動画(webm, VP9アルファ付き)のパス。未指定なら合成しない")
    parser.add_argument("--watermark-width", type=int, default=285, help="ウォーターマークのスケール後の横幅(px)")
    parser.add_argument("--upscale-720p", action="store_true", help="録画と同時に1280x720へアップスケールする(実験的、reports/21参照)")
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
    log("ウィンドウの安定を確認しました。録画を開始します(タイトル画面から)")

    ffmpeg_cmd = [
        "ffmpeg", "-y",
        "-f", "x11grab", "-draw_mouse", "0", "-video_size", f"{w}x{h}", "-framerate", "60",
        "-i", f"{DISPLAY}+{x},{y}",
        "-f", "pulse", "-i", PULSE_SOURCE,
    ]
    filters = []
    video_label = "0:v"
    if args.watermark:
        # ウォーターマークのwebmはVP9アルファ(Matroska BlockAdditional side data)を
        # 持っているが、ffmpegのデフォルト(ネイティブ)VP9デコーダはこれをマージせず
        # 常に不透明として扱ってしまう。libvpx経由のデコーダを明示指定する必要がある
        # (reports/18_phase18_watermark_overlay_verification.md参照)。
        watermark_w = min(args.watermark_width, w // 2)
        ffmpeg_cmd += ["-c:v", "libvpx-vp9", "-i", args.watermark]
        filters.append(f"[2:v]scale={watermark_w}:-1[wm]")
        filters.append(f"[{video_label}][wm]overlay=x=W-w-8:y=H-h-8:eof_action=pass[ov]")
        video_label = "ov"
    if args.upscale_720p:
        # 録画と同時に高さ720pxへアップスケールする(reports/21参照)。
        # th07は640x480(4:3)なのでアスペクト比を保つと960x720になる。1280x720(16:9)に
        # 固定すると横方向だけ引き伸ばされて映像が歪むため、実際のウィンドウ解像度から
        # 比率を保ったまま算出する(2の倍数に丸めてyuv420pの制約を満たす)。
        target_height = 720
        target_width = round(w * target_height / h / 2) * 2
        # CPU負荷増によるx11grab側の取りこぼし増加が懸念点のため、重複フレーム率で検証している。
        filters.append(f"[{video_label}]scale={target_width}:{target_height}:flags=lanczos[v720]")
        video_label = "v720"
    if filters:
        ffmpeg_cmd += [
            "-filter_complex", ";".join(filters),
            "-map", f"[{video_label}]", "-map", "1:a",
        ]
    ffmpeg_cmd += [
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

    sequence_complete_time = wait_for_log_marker(
        "sequence complete", timeout=20, poll_interval=0.1,
        log_all=True, seen_lines=seen_lines,
    )
    if sequence_complete_time is None:
        log("WARNING: MODのキーシーケンス完了ログが検出できませんでした")
        sequence_complete_time = time.time()

    gameplay_start = sequence_complete_time
    log(f"リプレイ再生開始とみなす時刻からの経過監視を開始します(猶予{POST_START_GRACE_SEC}秒)")

    prev_frame = None
    consecutive_still = 0
    detected = False
    poll_log = []
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
            poll_log.append((round(elapsed, 1), round(d, 2)))
            if d < STILL_MAD_THRESHOLD:
                consecutive_still += 1
            else:
                consecutive_still = 0
            log(f"poll: elapsed={elapsed:.1f}s MAD={d:.2f} consecutive_still={consecutive_still}")
            if consecutive_still >= STILL_CONSECUTIVE_REQUIRED:
                log("画面が一定時間変化しなくなったため、リプレイ終了と判定しました")
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
    if os.path.exists(args.output):
        log(f"出力ファイルサイズ: {os.path.getsize(args.output)} bytes")
    else:
        log(f"WARNING: 出力ファイルが見つかりません: {args.output}")
        if record_proc.returncode != 0:
            with open(ffmpeg_log_path, "rb") as f:
                tail = f.read()[-4000:]
            log(f"ffmpegログ(末尾4000バイト): {tail.decode(errors='replace')}")

    total_record_sec = time.time() - record_start
    log(f"録画終了。総録画時間: {total_record_sec:.1f}秒 検知方式: {'画面静止検知' if detected else 'タイムアウト'}")

    subprocess.run(["pkill", "-9", "-x", GAME_EXE])
    subprocess.run(["wineserver", "-k"], env=env)

    log(f"poll_log(elapsed_sec, MAD): {poll_log}")
    log(f"出力ファイル: {args.output}")


if __name__ == "__main__":
    main()
