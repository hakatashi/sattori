#!/usr/bin/env python3
"""th08(永夜抄)のリプレイファイルをXvfb+wine+ffmpegでヘッドレス録画し、
DLL MOD(mods/th08_replay_autoplay/)によるメニュー自動操作からリプレイ再生開始、
再生終了の自動検知・録画停止までを一気通貫で行う検証スクリプト。

scripts/11_record_th07_replay_e2e.py と構造・ロジックは同一(録画開始タイミング、
終了検知方式、MAD閾値の根拠等の詳細はそちらのdocstring・reports/11〜14参照)。
本スクリプトはth08固有のパス・ファイル名(games/th08はth08.exe/replay等すべて
小文字)とWINEPREFIX/injector/DLLのみを差し替えたもの。
"""
import argparse
import io
import os
import re
import signal
import subprocess
import sys
import time
from collections import Counter

import numpy as np
from PIL import Image

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

DISPLAY = ":98"
XVFB_SCREEN = "800x600x24"
WINEPREFIX = f"{REPO}/prefixes/th08-wined3d-gl"
INSTANCE_DIR = f"{REPO}/instances/th08-recording-test"
GAME_DIR_SRC = f"{REPO}/games/th08"
INJECTOR = "injector.exe"
GAME_EXE = "th08.exe"
HOOK_DLL = "th08_hook.dll"
LOG_PATH = f"{INSTANCE_DIR}/th08_autoplay.log"
PULSE_SOURCE = "auto_null.monitor"

STILL_MAD_THRESHOLD = 2.0
STILL_CONSECUTIVE_REQUIRED = 8  # 8 * POLL_INTERVAL_SEC = 16秒
POLL_INTERVAL_SEC = 2.0
POST_START_GRACE_SEC = 15.0
TIMEOUT_SEC = 40 * 60

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
        ["cp", f"{REPO}/mods/th08_replay_autoplay/build/{HOOK_DLL}", INSTANCE_DIR], check=True
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


STUTTER_PROBE_SAMPLES = 10
STUTTER_PROBE_INTERVAL_SEC = 0.15
STUTTER_PROBE_PERIOD_SEC = 60.0
STUTTER_DUP_FRACTION_THRESHOLD = 0.7
# 処理落ち(reports/12・13・22参照)は実測ではすべて録画開始から25秒以内に既に
# 発生していたため、早期打ち切りの判定はこの時間内に限定する。この時間を過ぎてからの
# 高い重複フレーム率は、処理落ちではなく「リプレイが正常に終了して結果画面(静止画面)
# に達した」ケースと区別がつかない(実際に約33分地点で正常終了を処理落ちと誤検知した
# 事例があった)ため、それ以降は既存の画面静止検知(consecutive_still)に判断を委ねる。
STUTTER_PROBE_ACTIVE_UNTIL_SEC = 300.0


# mods/common/fps_monitor.cpp が5秒ごとにログ出力する
# "FpsMonitor: N GetDeviceState calls in M ms (H.H Hz)" 行からHz値を読み取る。
# 正常時は55〜65Hz程度(垂直同期相当)で安定するが、fps暴走時は実測で479〜2700Hz
# まで跳ね上がることを確認済み(reports/22参照)。100Hzは両者の間に十分なマージンを
# 持たせた閾値。
FPS_MONITOR_HZ_RE = re.compile(r"FpsMonitor:.*\(([\d.]+) Hz\)")
FPS_RUNAWAY_HZ_THRESHOLD = 100.0


def scan_fps_runaway():
    """LOG_PATH全体からFpsMonitorのHz値を読み取り、閾値を超える最大値があれば返す(なければNone)。
    ファイル全体を毎回読み直す(ログは小さいため負荷は無視できる)ので、呼び出し側で
    「既読」管理をする必要がない。"""
    if not os.path.exists(LOG_PATH):
        return None
    with open(LOG_PATH) as f:
        text = f.read()
    hz_values = [float(v) for v in FPS_MONITOR_HZ_RE.findall(text)]
    over = [v for v in hz_values if v > FPS_RUNAWAY_HZ_THRESHOLD]
    return max(over) if over else None


def probe_stutter(x, y, w, h):
    """短時間(約1.5秒)に複数フレームを0.15秒間隔で連続キャプチャし、隣接フレーム間が
    ほぼ同一(MAD<STILL_MAD_THRESHOLD)である割合を返す。60fpsで本来動いているはずの
    短い間隔でこの割合が高ければ、処理落ち(重複フレーム多発、reports/12・13・22参照)
    の疑いが強い。POLL_INTERVAL_SEC(2秒)間隔の通常ポーリングでは、処理落ち中でも
    2秒あれば別のフレームを捉えてしまい見逃すため、この関数で意図的に短間隔サンプリング
    を行う。"""
    frames = [grab_frame(x, y, w, h)]
    for _ in range(STUTTER_PROBE_SAMPLES - 1):
        time.sleep(STUTTER_PROBE_INTERVAL_SEC)
        frames.append(grab_frame(x, y, w, h))
    dup_count = sum(
        1 for i in range(1, len(frames)) if mad(frames[i - 1], frames[i]) < STILL_MAD_THRESHOLD
    )
    return dup_count / (len(frames) - 1)


def attempt_recording(args):
    """録画を1回試行する。戻り値: dict(detected, total_record_sec, output_exists)。

    th08はCreateProcess(SUSPENDED)ベースの注入直後、内部fps較正が起動ごとに
    大きくばれる既知の問題があり(reports/08_phase8_*.md)、th07では問題にならな
    かった「実際のゲームプレイ中もfpsが数百〜数千に暴走する」ケースが新たに
    確認された(reports/22参照)。根本原因(タイマー較正がinjector注入の
    サスペンド時間に影響される疑い)は未解決のため、本関数は1回の試行結果を
    返すのみとし、暴走の検知・リトライは呼び出し側(main)が行う。
    """
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
        log("ERROR: th08.exe プロセスが検出できませんでした")
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
        watermark_w = min(args.watermark_width, w // 2)
        ffmpeg_cmd += ["-c:v", "libvpx-vp9", "-i", args.watermark]
        filters.append(f"[2:v]scale={watermark_w}:-1[wm]")
        filters.append(f"[{video_label}][wm]overlay=x=W-w-8:y=H-h-8:eof_action=pass[ov]")
        video_label = "ov"
    if args.upscale_720p:
        target_height = 720
        target_width = round(w * target_height / h / 2) * 2
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
    stutter_detected = False
    fps_runaway_hz = None
    quick_good = False
    poll_log = []
    next_stutter_probe = POST_START_GRACE_SEC
    quick_classify_sec = getattr(args, "quick_classify_sec", None)
    while True:
        elapsed = time.time() - gameplay_start
        if elapsed > TIMEOUT_SEC:
            log(f"TIMEOUT: {TIMEOUT_SEC}秒経過したため強制停止します")
            break

        runaway_hz = scan_fps_runaway()
        if runaway_hz is not None:
            log(
                f"WARNING: FpsMonitorログで異常な高fps({runaway_hz:.1f}Hz)を検知しました。"
                "fps暴走(reports/22参照)の疑いがあるため早期終了します"
            )
            fps_runaway_hz = runaway_hz
            break

        if quick_classify_sec is not None and elapsed >= quick_classify_sec:
            log(f"quick classify: {quick_classify_sec:.0f}秒間異常が検知されなかったため正常と判定します")
            quick_good = True
            break

        if elapsed < POST_START_GRACE_SEC:
            time.sleep(POLL_INTERVAL_SEC)
            continue

        if elapsed >= next_stutter_probe and elapsed < STUTTER_PROBE_ACTIVE_UNTIL_SEC:
            dup_fraction = probe_stutter(x, y, w, h)
            elapsed_after_probe = time.time() - gameplay_start
            next_stutter_probe = elapsed_after_probe + STUTTER_PROBE_PERIOD_SEC
            log(f"stutter probe: elapsed={elapsed_after_probe:.1f}s dup_fraction={dup_fraction:.2f}")
            if dup_fraction >= STUTTER_DUP_FRACTION_THRESHOLD:
                log(
                    f"WARNING: 短間隔サンプリングでの重複フレーム率({dup_fraction:.2f})が閾値"
                    f"({STUTTER_DUP_FRACTION_THRESHOLD})を超えました。処理落ち"
                    "(reports/12・13・22参照)の疑いがあるため早期終了します"
                )
                stutter_detected = True
                break
            prev_frame = None  # 直近のプローブでffmpeg呼び出しの時間が経っているため、次回はここから再計測する

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
    if fps_runaway_hz is not None:
        stop_reason = "fps暴走早期検知"
        classification = "fps_runaway"
    elif stutter_detected:
        stop_reason = "処理落ち早期検知"
        classification = "stutter"
    elif quick_good:
        stop_reason = "quick classify正常判定"
        classification = "good"
    elif detected:
        stop_reason = "画面静止検知"
        classification = "good"
    else:
        stop_reason = "タイムアウト"
        classification = "timeout"
    log(f"録画終了。総録画時間: {total_record_sec:.1f}秒 検知方式: {stop_reason}")

    subprocess.run(["pkill", "-9", "-x", GAME_EXE])
    subprocess.run(["wineserver", "-k"], env=env)

    log(f"poll_log(elapsed_sec, MAD): {poll_log}")
    log(f"出力ファイル: {args.output}")

    return {
        "detected": detected,
        "stutter_detected": stutter_detected,
        "fps_runaway_hz": fps_runaway_hz,
        "quick_good": quick_good,
        "classification": classification,
        "total_record_sec": total_record_sec,
        "output_exists": os.path.exists(args.output),
    }


def measure_duplicate_rate(video_path, start_sec, duration_sec):
    """scripts/measure_duplicate_frame_rate.shを呼び出し、重複フレーム率(%)を返す。失敗時はNone。"""
    result = subprocess.run(
        ["bash", f"{REPO}/scripts/measure_duplicate_frame_rate.sh", video_path, str(start_sec), str(duration_sec)],
        capture_output=True, text=True,
    )
    for line in result.stdout.splitlines():
        if "duplicate_rate=" in line:
            try:
                return float(line.split("duplicate_rate=")[1].rstrip("%"))
            except ValueError:
                return None
    return None


def run_stats(args):
    """--stats-runs回、quick_classify_sec秒だけ様子を見て早期に打ち切る試行を繰り返し、
    fps暴走・処理落ち・正常の内訳(成功率)を集計する。本番録画(main()の通常経路)とは
    異なり、正常な試行であってもリプレイの自然な終了を待たずに打ち切るため、
    1試行あたり最大でもquick_classify_sec+数十秒程度で済む。"""
    n = args.stats_runs
    if args.quick_classify_sec is None:
        args.quick_classify_sec = 60.0
        log(f"--quick-classify-sec未指定のため既定値{args.quick_classify_sec:.0f}秒を使用します")

    results = []
    for i in range(1, n + 1):
        log(f"=== 統計試行 {i}/{n} ===")
        result = attempt_recording(args)
        results.append(result)
        log(
            f"試行{i}結果: classification={result['classification']} "
            f"total_record_sec={result['total_record_sec']:.1f}s"
        )

    counts = Counter(r["classification"] for r in results)
    log(f"=== 統計結果(replay={args.replay}, n={n}, quick_classify_sec={args.quick_classify_sec:.0f}) ===")
    for key in ("good", "fps_runaway", "stutter", "timeout"):
        c = counts.get(key, 0)
        log(f"  {key}: {c}/{n} ({c / n * 100:.1f}%)")
    known = sum(counts.get(key, 0) for key in ("good", "fps_runaway", "stutter", "timeout"))
    if known < n:
        log(f"  other: {n - known}/{n} ({(n - known) / n * 100:.1f}%)")
    good = counts.get("good", 0)
    log(f"成功率: {good}/{n} ({good / n * 100:.1f}%)")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--replay", default="th8_02.rpy")
    parser.add_argument("--output", default=f"{REPO}/runs/th08_full_replay_audio/video.mp4")
    parser.add_argument("--watermark", default=None, help="右下に合成するウォーターマーク動画(webm, VP9アルファ付き)のパス。未指定なら合成しない")
    parser.add_argument("--watermark-width", type=int, default=285, help="ウォーターマークのスケール後の横幅(px)")
    parser.add_argument("--upscale-720p", action="store_true", help="録画と同時に720pへアップスケールする(reports/21参照、4vCPU構成では非推奨)")
    parser.add_argument("--expected-min-sec", type=float, default=None,
                         help="(過去の互換用、現在は未使用) fps暴走の検知はFpsMonitorログのHz値で直接行うようになった(reports/22参照)")
    parser.add_argument("--max-attempts", type=int, default=3, help="異常検知時の最大試行回数")
    parser.add_argument("--max-duplicate-rate", type=float, default=30.0,
                         help="録画開始15〜45秒区間の重複フレーム率(%%)がこれを超えたら、ウィンドウ再作成等による処理落ち"
                              "(reports/12・13・22参照)とみなし自動リトライする")
    parser.add_argument("--quick-classify-sec", type=float, default=None,
                         help="指定すると、この秒数の間fps暴走・処理落ちが検知されなければ「正常」とみなし、"
                              "リプレイの自然な終了を待たずに早期に打ち切る。主に--stats-runsでの統計測定用")
    parser.add_argument("--stats-runs", type=int, default=None,
                         help="指定すると、単発の録画ではなくこの回数だけ試行を繰り返して成功率を測定するモードになる"
                              "(--quick-classify-secと組み合わせる。未指定なら60秒を既定値として使う)")
    args = parser.parse_args()

    os.makedirs(os.path.dirname(args.output), exist_ok=True)

    if args.stats_runs is not None:
        run_stats(args)
        return

    for attempt in range(1, args.max_attempts + 1):
        log(f"=== 試行 {attempt}/{args.max_attempts} ===")
        result = attempt_recording(args)
        if not result["output_exists"]:
            log("WARNING: 出力ファイルが生成されなかったため、この試行は失敗として扱います")
            continue
        if result["classification"] == "fps_runaway":
            log(
                f"WARNING: fps暴走({result['fps_runaway_hz']:.1f}Hz、reports/22参照)を検知したため"
                "破棄してリトライします"
            )
            continue
        if result["classification"] == "stutter":
            log("WARNING: 処理落ちの早期検知によりこの試行を破棄してリトライします")
            continue
        dup_rate = measure_duplicate_rate(args.output, 15, min(30, max(5, result["total_record_sec"] - 15)))
        log(f"録画開始15秒以降の重複フレーム率: {dup_rate}%")
        if dup_rate is not None and dup_rate > args.max_duplicate_rate:
            log(
                f"WARNING: 重複フレーム率({dup_rate}%)が閾値({args.max_duplicate_rate}%)を超えました。"
                "処理落ち(reports/12・13・22参照)の疑いがあるため破棄してリトライします"
            )
            continue
        log(f"試行{attempt}で正常な録画を確認しました")
        return

    log(f"ERROR: {args.max_attempts}回試行しても正常な録画が得られませんでした")
    sys.exit(1)


if __name__ == "__main__":
    main()
