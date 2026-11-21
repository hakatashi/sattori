#!/usr/bin/env python3
"""th08(永夜抄) ver1.00d(games/th08_ver100d)向けのfps暴走再検証スクリプト。

scripts/22_record_th08_replay_e2e.py のコピーで、GAME_DIR_SRC/INSTANCE_DIR/DISPLAY
のみをver1.00d用に差し替えている(ver1.00aの旧環境games/th08と並行してテストできる
ようにするため)。fps暴走・処理落ちの検知ロジックは22と同一。詳細はreports/23参照。
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

DISPLAY = ":99"
XVFB_SCREEN = "800x600x24"
WINEPREFIX = f"{REPO}/prefixes/th08-wined3d-gl"
INSTANCE_DIR = f"{REPO}/instances/th08-ver100d-recording-test"
GAME_DIR_SRC = f"{REPO}/games/th08_ver100d"
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


def ffprobe_start_time(path):
    """-copytsで保持した絶対wallclock秒(epoch秒)のstart_timeを取得する。取得失敗時はNoneを返す。"""
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=start_time",
             "-of", "default=nw=1:nk=1", path],
            env=env, capture_output=True, text=True, timeout=10,
        )
        return float(out.stdout.strip())
    except (subprocess.SubprocessError, ValueError, OSError):
        return None


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
# 正常時は55〜65Hz程度(垂直同期相当)で安定するが、ver1.00aでのfps暴走時は実測で
# 479〜2700Hzまで跳ね上がり、かつリプレイ全編を通じて持続する(実時間換算39秒前後で
# リプレイが終わってしまうため)ことを確認済み(reports/22参照)。
#
# ver1.00dで同一条件を再検証したところ(reports/23参照)、この持続的な暴走は再現しなく
# なった一方、th8_03.rpy(Hard)のフル録画で録画開始から約25分経過した一時点のみ
# 118.1Hzという単発のスパイクを観測した(前後は59.9〜82.3Hzの通常範囲に復帰、MAD推移も
# 前後で完全に連続的、重複フレーム率も0.8%と良好)。これはゲームプレイに実害のない
# 一時的なタイミングの揺らぎと判断し、単発の閾値超過では誤検知扱いにしないよう、
# 閾値超過が2回連続(FpsMonitorの出力間隔5秒×2=約10秒間持続)した場合のみ異常とみなす
# ように変更した。ver1.00aの実際の暴走はリプレイ全編にわたり持続するため、この条件でも
# 数秒の遅れで確実に検知できる。
FPS_MONITOR_HZ_RE = re.compile(r"FpsMonitor:.*\(([\d.]+) Hz\)")
FPS_RUNAWAY_HZ_THRESHOLD = float(os.environ.get("FPS_RUNAWAY_HZ_THRESHOLD", "100.0"))
FPS_RUNAWAY_CONSECUTIVE_REQUIRED = 2


def scan_fps_runaway():
    """LOG_PATH全体からFpsMonitorのHz値を読み取り、閾値超過が
    FPS_RUNAWAY_CONSECUTIVE_REQUIRED回連続していればその最大値を返す(なければNone)。
    ファイル全体を毎回読み直す(ログは小さいため負荷は無視できる)ので、呼び出し側で
    「既読」管理をする必要がない。"""
    if not os.path.exists(LOG_PATH):
        return None
    with open(LOG_PATH) as f:
        text = f.read()
    hz_values = [float(v) for v in FPS_MONITOR_HZ_RE.findall(text)]
    for i in range(len(hz_values) - FPS_RUNAWAY_CONSECUTIVE_REQUIRED + 1):
        window = hz_values[i:i + FPS_RUNAWAY_CONSECUTIVE_REQUIRED]
        if all(v > FPS_RUNAWAY_HZ_THRESHOLD for v in window):
            return max(window)
    return None


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


def find_live_game_pid():
    """GAME_EXEのPIDのうち、zombie(状態Z)ではないものを1つ返す(なければNone)。
    コンテナ内ではPID 1(entrypoint.py)がinitのように孤児プロセスをreapする仕組みを
    持たないため、前の試行でSIGKILLしたth08.exeがzombieのまま残り続けることがある。
    `pgrep -x`はzombieもマッチしてしまうため、2回目以降の試行で新しいth08.exeでは
    なく前回のzombieのPIDを掴んでしまい、ウィンドウが永遠に見つからない原因になって
    いた(reports/24参照)。"""
    out = subprocess.run(["pgrep", "-x", GAME_EXE], capture_output=True, text=True).stdout.split()
    for pid in out:
        try:
            with open(f"/proc/{pid}/stat") as f:
                stat = f.read()
            state = stat.rsplit(") ", 1)[-1].split()[0]
        except FileNotFoundError:
            continue
        if state != "Z":
            return pid
    return None


def find_pids_for_wineprefix(wineprefix):
    """指定WINEPREFIXの環境変数を持つプロセスのPID一覧を返す。

    GAME_EXEやwineserver自体だけでは、winedevice.exe等のWineが内部生成する
    子プロセスを個別には捕捉できない。`wineserver -w`がタイムアウトした際の
    フォールバックとして、当該WINEPREFIX配下の全プロセスを直接SIGKILLするために
    使う(reports/55参照)。
    """
    pids = []
    target = f"WINEPREFIX={wineprefix}".encode()
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        try:
            with open(f"/proc/{entry}/environ", "rb") as f:
                environ = f.read()
        except OSError:
            continue
        if target in environ.split(b"\0"):
            pids.append(int(entry))
    return pids


def kill_wine_and_wait():
    """th08.exeとwineserverを終了させ、実際にwineserverが終了するまで待つ。
    固定sleepで待っていたところ、AWS c7i.xlargeのようにCPUが逼迫した環境では
    wineserverの終了処理自体に2秒以上かかることがあり、終了前に次の試行の
    injectorを起動してウィンドウ検出に失敗する事象が再現した(reports/24参照)。
    `wineserver -w`は現在起動中のwineserverが実際に終了するまでブロックするため、
    固定時間の推測より確実。

    attempt_recordingのtry/finally(reports/55参照)から、録画処理がどこで
    例外・タイムアウトを起こしても必ず呼ばれることを前提にしている。
    `wineserver -w`自体がタイムアウトした場合(ゲームプロセスがGPU待ち等で
    カーネルレベルで割り込み不可能な状態(D state)にあり`pkill -9`が即座に
    効かない場合など)に例外を伝播させて後片付け処理自体を止めてしまわないよう、
    ここでtimeoutを捕捉し、当該WINEPREFIX配下の残存プロセスを直接SIGKILLする
    フォールバックを行う。
    """
    subprocess.run(["pkill", "-9", "-x", GAME_EXE])
    subprocess.run(["wineserver", "-k"], env=env)
    try:
        subprocess.run(["wineserver", "-w"], env=env, timeout=60)
    except subprocess.TimeoutExpired:
        log(
            f"WARNING: wineserver -w が60秒以内に終了しませんでした。"
            f"WINEPREFIX={WINEPREFIX} 配下の残存プロセスをSIGKILLで強制終了します(reports/55参照)"
        )
        pids = find_pids_for_wineprefix(WINEPREFIX)
        for pid in pids:
            try:
                os.kill(pid, signal.SIGKILL)
                log(f"  PID {pid} をSIGKILLしました")
            except ProcessLookupError:
                pass
        if not pids:
            log("  WARNING: WINEPREFIXに紐づく残存プロセスが見つかりませんでした")


def _setup_failure_result():
    """game_pid/ウィンドウ検出/安定確認のいずれかが失敗した場合の戻り値。
    以前はsys.exit(1)でプロセス全体を落としていたため、main()のリトライループに
    制御が戻らずリトライが機能しない上、entrypoint側が終了コードを見ずに
    アップロードしてしまうと失敗がそのまま隠れてしまう問題があった(reports/24参照)。
    output_exists=Falseにしておけばmain()の既存の失敗判定(該当行参照)がそのまま効く。

    wineserver/winedeviceの後片付けはここでは行わない。呼び出し元
    attempt_recordingのtry/finallyが一元的に(このreturnの後で)kill_wine_and_wait
    を呼ぶため、ここで呼ぶと二重実行になる(reports/55参照)。"""
    return {
        "detected": False,
        "stutter_detected": False,
        "fps_runaway_hz": None,
        "quick_good": False,
        "classification": "setup_error",
        "total_record_sec": 0.0,
        "output_exists": False,
    }


def attempt_recording(args):
    """録画を1回試行する。戻り値: dict(detected, total_record_sec, output_exists)。

    th08はCreateProcess(SUSPENDED)ベースの注入直後、内部fps較正が起動ごとに
    大きくばれる既知の問題があり(reports/08_phase8_*.md)、th07では問題にならな
    かった「実際のゲームプレイ中もfpsが数百〜数千に暴走する」ケースが新たに
    確認された(reports/22参照)。根本原因(タイマー較正がinjector注入の
    サスペンド時間に影響される疑い)は未解決のため、本関数は1回の試行結果を
    返すのみとし、暴走の検知・リトライは呼び出し側(main)が行う。
    """
    try:
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
            game_pid = find_live_game_pid()
            if game_pid:
                break
            time.sleep(0.1)
        if not game_pid:
            log("ERROR: th08.exe プロセスが検出できませんでした")
            return _setup_failure_result()
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
            return _setup_failure_result()
        x, y, w, h, winid = geom
        log(f"ウィンドウ検出: x={x} y={y} w={w} h={h} (winid={winid})")

        seen_lines = set()
        stable_time = wait_for_log_marker(
            "WaitForStableWindow: stable", timeout=20, poll_interval=0.1,
            log_all=True, seen_lines=seen_lines,
        )
        if stable_time is None:
            log("ERROR: ウィンドウの安定を確認できませんでした")
            return _setup_failure_result()
        log("ウィンドウの安定を確認しました。録画を開始します(タイトル画面から)")

        # フェーズ26で、AWS環境ではx11grab(映像)とpulse(音声)を1つのffmpegプロセスで
        # 同時に取り込むと、th08の描画タイミングがffmpeg内部のA/V同期に律速されて重複
        # フレーム率が85%超に悪化することを特定した。映像と音声を別プロセスで録画し後で
        # muxすれば、同じ音声を録りながらでも映像は正常(2%前後)になる。詳細はreports/26参照。
        separate_audio = not getattr(args, "muxed_audio", False)
        inline_audio = not separate_audio

        if separate_audio:
            base, _ext = os.path.splitext(args.output)
            video_target = f"{base}.video.mp4"
            audio_target = f"{base}.audio.m4a"
        else:
            video_target = args.output

        ffmpeg_cmd = ["ffmpeg", "-y"]
        if separate_audio:
            # フェーズ27追補3で発覚した音ズレ(音声が映像より約700ms先行)対策。
            # -copytsでx11grab/pulseそれぞれのwallclockベースの絶対pts(epoch秒)を
            # そのまま出力ファイルのstart_timeに残し、mux時に実測した差分だけ補正する。
            # 詳細はreports/28参照。
            ffmpeg_cmd += ["-copyts"]
        ffmpeg_cmd += [
            "-f", "x11grab", "-draw_mouse", "0", "-video_size", f"{w}x{h}", "-framerate", "60",
            "-i", f"{DISPLAY}+{x},{y}",
        ]
        if inline_audio:
            ffmpeg_cmd += ["-f", "pulse", "-i", PULSE_SOURCE]
        wm_input_idx = 2 if inline_audio else 1
        filters = []
        video_label = "0:v"
        if args.watermark:
            watermark_w = min(args.watermark_width, w // 2)
            ffmpeg_cmd += ["-c:v", "libvpx-vp9", "-i", args.watermark]
            filters.append(f"[{wm_input_idx}:v]scale={watermark_w}:-1[wm]")
            filters.append(f"[{video_label}][wm]overlay=x=W-w-8:y=H-h-8:eof_action=pass[ov]")
            video_label = "ov"
        if args.upscale_720p:
            target_height = 720
            target_width = round(w * target_height / h / 2) * 2
            filters.append(f"[{video_label}]scale={target_width}:{target_height}:flags=lanczos[v720]")
            video_label = "v720"
        if filters:
            ffmpeg_cmd += ["-filter_complex", ";".join(filters), "-map", f"[{video_label}]"]
            if inline_audio:
                ffmpeg_cmd += ["-map", "1:a"]
        ffmpeg_cmd += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p"]
        if inline_audio:
            ffmpeg_cmd += ["-c:a", "aac", "-b:a", "192k"]
        ffmpeg_cmd += [video_target]
        log(f"録画開始(映像): {' '.join(ffmpeg_cmd)}")
        ffmpeg_log_path = f"{os.path.dirname(args.output)}/ffmpeg.log"
        ffmpeg_log_file = open(ffmpeg_log_path, "wb")
        record_proc = subprocess.Popen(
            ffmpeg_cmd, env=env,
            stdin=subprocess.PIPE, stdout=ffmpeg_log_file, stderr=subprocess.STDOUT,
        )
        audio_proc = None
        audio_log_file = None
        if separate_audio:
            audio_cmd = [
                "ffmpeg", "-y", "-copyts", "-f", "pulse", "-i", PULSE_SOURCE,
                "-c:a", "aac", "-b:a", "192k", audio_target,
            ]
            log(f"録画開始(音声・別プロセス): {' '.join(audio_cmd)}")
            audio_log_path = f"{os.path.dirname(args.output)}/ffmpeg_audio.log"
            audio_log_file = open(audio_log_path, "wb")
            audio_proc = subprocess.Popen(
                audio_cmd, env=env,
                stdin=subprocess.PIPE, stdout=audio_log_file, stderr=subprocess.STDOUT,
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
        if audio_proc is not None:
            audio_proc.send_signal(signal.SIGINT)
        try:
            record_proc.wait(timeout=20)
        except subprocess.TimeoutExpired:
            log("WARNING: ffmpeg(映像) が時間内に終了しなかったため terminate します")
            record_proc.terminate()
            record_proc.wait(timeout=10)
        ffmpeg_log_file.close()
        log(f"ffmpeg(映像) exit_code={record_proc.returncode}")
        if audio_proc is not None:
            try:
                audio_proc.wait(timeout=20)
            except subprocess.TimeoutExpired:
                log("WARNING: ffmpeg(音声) が時間内に終了しなかったため terminate します")
                audio_proc.terminate()
                audio_proc.wait(timeout=10)
            audio_log_file.close()
            log(f"ffmpeg(音声) exit_code={audio_proc.returncode}")
            # フェーズ27追補3で発覚した音ズレ対策: x11grab(映像)とpulse(音声)は実際に
            # キャプチャが始まるまでの初期化レイテンシが異なり(音声側が数百ms〜1秒超
            # 遅い)、-copytsで保持した絶対start_time(wallclockベース、epoch秒)の差分を
            # 使って、遅く始まった側に-itsoffsetを与えて補正する。詳細はreports/28参照。
            video_offset = 0.0
            audio_offset = 0.0
            v_start = ffprobe_start_time(video_target)
            a_start = ffprobe_start_time(audio_target)
            if v_start is not None and a_start is not None:
                delta = a_start - v_start
                if delta > 0:
                    audio_offset = delta
                elif delta < 0:
                    video_offset = -delta
                log(
                    f"A/V同期補正: video_start={v_start:.3f} audio_start={a_start:.3f} "
                    f"delta={delta:+.3f}s (video_offset={video_offset:.3f}s audio_offset={audio_offset:.3f}s)"
                )
            else:
                log("WARNING: -copytsのstart_time取得に失敗したため、A/V同期補正をスキップします")
            mux_cmd = ["ffmpeg", "-y"]
            if video_offset:
                mux_cmd += ["-itsoffset", f"{video_offset:.6f}"]
            mux_cmd += ["-i", video_target]
            if audio_offset:
                mux_cmd += ["-itsoffset", f"{audio_offset:.6f}"]
            mux_cmd += ["-i", audio_target, "-c", "copy", "-shortest", args.output]
            log(f"mux実行: {' '.join(mux_cmd)}")
            mux = subprocess.run(mux_cmd, env=env, capture_output=True)
            if mux.returncode != 0:
                log(f"WARNING: mux失敗 (returncode={mux.returncode}): {mux.stderr[-2000:].decode(errors='replace')}")

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

        # wineserver/winedeviceの後片付けは、関数末尾のtry/finally(下記)が一元的に
        # 行う(正常終了・早期return・例外のいずれの経路でも必ず1回実行される。
        # reports/55参照)ため、ここでは呼ばない。

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
    finally:
        # 録画処理本体のどこで例外・タイムアウト・外部シグナルが発生しても
        # wineserver/winedeviceが放置されないことを保証する(放置すると
        # ホストのsystem D-Busのメッセージキューを枯渇させ、システム全体の
        # ハングを引き起こしうる。reports/55参照)。
        kill_wine_and_wait()


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
    parser.add_argument("--muxed-audio", action="store_true",
                        help="映像と音声を1つのffmpegプロセスで同時取り込みする旧来方式。"
                             "AWS環境ではth08の重複フレーム率が85%超に悪化するため非推奨"
                             "(既定は映像・音声を別プロセスで録画して後muxする方式、reports/26参照)")
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
