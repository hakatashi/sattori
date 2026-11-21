"""フレーム同期キャプチャ(`--frame-sync`)での録画1回ぶんの試行(reports/104・105)。

通常の録画(`recorder/pipeline.py`)は、ゲームを実時間で動かしてx11grabで外から取り込む。
こちらは、MOD(`mods/common/frame_sync_hook`)がゲームの1フレームごとにバックバッファを
読み出してFIFOへ書き、ffmpegがそれを`rawvideo`として読む。FIFOが詰まるとゲームの
書き込みがブロックするので、描画とエンコードの遅いほうが律速になり、ゲームは可変速で進む。

通常の録画との違い:

  - **時間の基準は実時間ではなく動画のフレーム番号。** 終了検知の「2秒間隔で8回連続静止」
    も動画上の秒数で数える(終了検知用サブ出力は動画の1秒につき`POLL_STREAM_FPS`枚)。
  - **fps暴走検知・処理落ち早期検知は行わない。** FpsMonitorが数百Hzを示すのが正常で、
    落ちフレームは原理的に起きない。代わりに「MODが書いたフレーム数=動画のフレーム数」を
    録画後に照合する。
  - **音声はPulseAudioから録らない。** MOD内の仮想音声デバイス(`mods/common/frame_sync_audio`)が
    映像の1フレームにつき735サンプル(44100Hz÷60)をミックスしてファイルへ書き、録画後に映像と
    結合する(reports/107)。`--no-audio`なら映像だけ。
  - Xのウィンドウ位置は使わない(取り込みはバックバッファから行う)。

MOD側の対応が要る(`InstallFrameSyncHook()`と、リプレイ再生開始時の
`FrameSyncSetUnthrottled(true)`)。対応済みのタイトルはreports/105を参照。
"""
import fcntl
import os
import re
import signal
import subprocess
import time

import numpy as np

from .log import log
from .modlog import wait_for_log_marker
from .process import kill_wine_and_wait
from .sync_marker import windows_path
from .timing import MENU_TIME_SCALE, NATIVE_FRAME_RATE_HZ
from .vision import FRAME_H, FRAME_W, POLL_STREAM_FPS, STILL_MAD_THRESHOLD, mad_masked

# FIFOのバッファ。既定の64KiBでは1フレーム(1280x960で約4.9MB)の受け渡しに往復が多いので、
# 非特権で設定できる上限(/proc/sys/fs/pipe-max-size の既定値)まで広げる。
PIPE_BUFFER_BYTES = 1 << 20
_F_SETPIPE_SZ = 1031

# 検証用: libx264のプリセット。エンコードも律速の一部になるので比較できるようにしてある。
X264_PRESET = os.environ.get("FRAME_SYNC_X264_PRESET", "veryfast")

# 終了検知のサンプリング間隔(動画上の秒数)。通常の録画のPOLL_INTERVAL_SECに相当する。
SAMPLE_INTERVAL_VIDEO_SEC = 2.0
# サブ出力がこの実時間のあいだ1枚も増えなければ、ゲームが止まったとみなして打ち切る。
STALL_TIMEOUT_SEC = 120.0
# 最初のフレームの形式がMODログに出るまでの待ち(ゲームの起動からデバイス作成まで)。
CAPTURE_START_TIMEOUT_SEC = 60.0

_CAPTURE_START_RE = re.compile(
    r"FrameSync: capture start width=(\d+) height=(\d+) d3dfmt=\d+ pix_fmt=(\w+)")
_CAPTURE_STOPPED_RE = re.compile(r"FrameSync: capture stopped frames_written=(\d+)")
_UNTHROTTLED_RE = re.compile(r"FrameSync: unthrottled=1 at frame=(\d+)")


def pipe_path(config):
    return f"{config.instance_dir}/framesync.fifo"


def stop_path(config):
    return f"{config.instance_dir}/framesync.stop"


def _open_pipe(config):
    """FIFOを作り、読み書き両用で開いておく。

    録画側が読み口を持ち続けることで、(1) ffmpegの起動前でもMODがFIFOを開ける、
    (2) バッファを広げた設定がFIFOの寿命のあいだ保たれる。ffmpegにEOFを届けるには、
    MODが閉じたあとでこのfdも閉じる必要がある。
    """
    os.makedirs(config.instance_dir, exist_ok=True)
    for path in (pipe_path(config), stop_path(config)):
        try:
            os.remove(path)
        except FileNotFoundError:
            pass
    os.mkfifo(pipe_path(config))
    fd = os.open(pipe_path(config), os.O_RDWR)
    size = fcntl.fcntl(fd, _F_SETPIPE_SZ, PIPE_BUFFER_BYTES)
    log(f"フレーム同期用FIFOを作成しました ({pipe_path(config)}, バッファ{size}バイト)")
    return fd


def _read_log(config):
    try:
        with open(config.log_path, errors="replace") as f:
            return f.read()
    except OSError:
        return ""


# 仮想音声デバイスが書くPCMの形式(mods/common/frame_sync_audio.h)。
AUDIO_RATE_HZ = 44100
AUDIO_BYTES_PER_VIDEO_FRAME = AUDIO_RATE_HZ // 60 * 2 * 2  # 735サンプル × 2ch × 16bit


def audio_raw_path(options):
    return f"{os.path.splitext(options.output)[0]}.audio.pcm"


def _mux_audio(video_path, raw_path, output, env):
    """映像と仮想音声デバイスのPCMを結合する。両者は同じフレーム数なので位置合わせは要らない。"""
    cmd = ["ffmpeg", "-y", "-nostdin", "-v", "error", "-i", video_path,
           "-f", "s16le", "-ar", str(AUDIO_RATE_HZ), "-ac", "2", "-i", raw_path,
           "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
           "-movflags", "+faststart", output]
    log(f"音声を結合します: {' '.join(cmd)}")
    r = subprocess.run(cmd, env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True)
    if r.returncode != 0:
        log(f"ERROR: 音声の結合に失敗しました: {r.stderr[-2000:]}")
        return False
    return True


def _build_video_cmd(config, options, width, height, pix_fmt, poll_raw_path, video_path):
    """FIFOからrawvideoを読んでエンコードするffmpegコマンド。

    終了検知用のサブ出力(160x120 gray、動画の1秒につきPOLL_STREAM_FPS枚)は通常の録画の
    `poll_side_stream`と同じ形式。入力のタイムスタンプが動画のフレーム番号から決まるので、
    サブ出力のk枚目は必ず動画のk/POLL_STREAM_FPS秒の画面になる。
    """
    video_enc = (
        ["-c:v", "h264_nvenc", "-preset", "p4", "-rc", "vbr", "-cq", "23", "-b:v", "5M",
         "-maxrate", "6M", "-pix_fmt", "yuv420p"]
        if options.gpu_encode
        else ["-c:v", "libx264", "-preset", X264_PRESET, "-crf", "18", "-pix_fmt", "yuv420p"]
    )
    return [
        "ffmpeg", "-y", "-nostdin",
        "-f", "rawvideo", "-pix_fmt", pix_fmt, "-video_size", f"{width}x{height}",
        "-framerate", f"{NATIVE_FRAME_RATE_HZ:g}", "-i", pipe_path(config),
        "-filter_complex",
        "[0:v]split=2[vmain][vpollsrc];"
        f"[vpollsrc]fps={POLL_STREAM_FPS:g},scale={FRAME_W}:{FRAME_H},format=gray[vpollout]",
        "-map", "[vmain]",
        *video_enc,
        video_path,
        "-map", "[vpollout]", "-f", "rawvideo", "-pix_fmt", "gray", "-flush_packets", "1",
        poll_raw_path,
    ]


def _poll_frame_count(path):
    try:
        return os.stat(path).st_size // (FRAME_W * FRAME_H)
    except OSError:
        return 0


def _read_poll_frame_at(path, number):
    """サブ出力のnumber枚目(1始まり)を読む。"""
    size = FRAME_W * FRAME_H
    with open(path, "rb") as f:
        f.seek((number - 1) * size)
        buf = f.read(size)
    if len(buf) < size:
        return None
    return np.frombuffer(buf, dtype=np.uint8).reshape(FRAME_H, FRAME_W).astype(np.float32)


def _monitor_until_end(options, detection, video_proc, poll_raw_path, start_number,
                       grace_video_sec, timeout_sec, consecutive_still_required,
                       consecutive_template_required):
    """リプレイ終了を検知するまで、サブ出力を動画上の一定間隔で調べる。

    戻り値は (検知方式 or None, 終了時点の動画秒 or None, poll_log)。
    """
    stride = round(SAMPLE_INTERVAL_VIDEO_SEC * POLL_STREAM_FPS)
    next_number = start_number + round(grace_video_sec * POLL_STREAM_FPS)
    prev_frame = None
    prev_number = None
    streak_start_number = None
    consecutive_still = 0
    consecutive_template = 0
    poll_log = []
    real_start = time.time()
    last_progress = (time.time(), _poll_frame_count(poll_raw_path))

    while True:
        now = time.time()
        if now - real_start > timeout_sec:
            log(f"TIMEOUT: 実時間{timeout_sec:.0f}秒経過したため強制停止します")
            return None, None, poll_log
        if video_proc.poll() is not None:
            log(f"ERROR: 録画用ffmpegが終了しています (returncode={video_proc.returncode})")
            return None, None, poll_log

        available = _poll_frame_count(poll_raw_path)
        if available != last_progress[1]:
            last_progress = (now, available)
        elif now - last_progress[0] > STALL_TIMEOUT_SEC:
            log(f"ERROR: {STALL_TIMEOUT_SEC:.0f}秒間フレームが届いていません。ゲームが止まったと"
                "みなして中止します")
            return None, None, poll_log
        if available < next_number:
            time.sleep(0.1)
            continue

        frame = _read_poll_frame_at(poll_raw_path, next_number)
        if frame is None:
            time.sleep(0.1)
            continue
        video_sec = next_number / POLL_STREAM_FPS
        since_start = (next_number - start_number) / POLL_STREAM_FPS
        real_sec = now - real_start
        speed = since_start / real_sec if real_sec > 0 else 0.0

        if options.record_seconds is not None and since_start >= options.record_seconds:
            log(f"record-seconds: 動画上で{options.record_seconds:.0f}秒ぶん録画したため停止します")
            return "record_seconds", video_sec, poll_log

        if detection.end_template is not None:
            d = mad_masked(frame, detection.end_template, detection.end_template_mask)
            if d < detection.end_template_mad_threshold:
                if consecutive_template == 0:
                    streak_start_number = next_number
                consecutive_template += 1
            else:
                consecutive_template = 0
            poll_log.append((round(video_sec, 1), round(d, 2)))
            log(f"poll: video={video_sec:.1f}s real={real_sec:.1f}s 平均{speed:.2f}倍速 "
                f"template_MAD={d:.2f} end_template_consecutive={consecutive_template}")
            if consecutive_template >= consecutive_template_required:
                log("リプレイ選択画面と連続して一致したため、リプレイ終了と判定しました")
                return "template", streak_start_number / POLL_STREAM_FPS, poll_log
        elif prev_frame is not None:
            d = mad_masked(prev_frame, frame, detection.still_mask)
            if d < STILL_MAD_THRESHOLD:
                if consecutive_still == 0:
                    streak_start_number = prev_number
                consecutive_still += 1
            else:
                consecutive_still = 0
            poll_log.append((round(video_sec, 1), round(d, 2)))
            log(f"poll: video={video_sec:.1f}s real={real_sec:.1f}s 平均{speed:.2f}倍速 "
                f"MAD={d:.2f} consecutive_still={consecutive_still}")
            if consecutive_still >= consecutive_still_required:
                log("画面が一定時間変化しなくなったため、リプレイ終了と判定しました")
                return "still", streak_start_number / POLL_STREAM_FPS, poll_log
        prev_frame = frame
        prev_number = next_number
        next_number += stride


def _count_video_frames(path, env):
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-count_packets",
         "-show_entries", "stream=nb_read_packets", "-of", "csv=p=0", path],
        env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True)
    try:
        return int(r.stdout.strip().split(",")[0])
    except (ValueError, IndexError):
        return None


def attempt_recording_frame_sync(config, options):
    """フレーム同期キャプチャで1回だけ録画を試みる。プロセスの後片付けまで含めて完結する。"""
    # 循環importを避けるためここで読む(pipelineはこのモジュールを遅延importする)。
    from .pipeline import (END_TEMPLATE_CONSECUTIVE_REQUIRED, MOD_MARKER_TIMEOUT_SEC,
                           POST_START_GRACE_SEC, STILL_CONSECUTIVE_REQUIRED, TIMEOUT_SEC,
                           RecordingResult, _build_detection, _launch_game)

    if MENU_TIME_SCALE != 1.0:
        raise RuntimeError("--frame-sync は倍速・低速録画(FPS_LIMIT_TARGET_HZ)と併用できません")

    env = config.build_env()
    env.pop("SYNC_MARKER_TRIGGER", None)
    env["FRAME_SYNC_PIPE"] = windows_path(pipe_path(config))
    env["FRAME_SYNC_STOP"] = windows_path(stop_path(config))
    poll_raw_path = options.poll_raw_path
    with_audio = not options.no_audio
    video_path = options.video_target if with_audio else options.output
    raw_path = audio_raw_path(options)
    for path in (raw_path, video_path, options.output):
        if os.path.exists(path):
            os.remove(path)
    if with_audio:
        env["FRAME_SYNC_AUDIO"] = windows_path(raw_path)
    pipe_fd = None
    video_proc = None
    video_log_file = None
    try:
        pipe_fd = _open_pipe(config)
        if os.path.exists(poll_raw_path):
            os.remove(poll_raw_path)

        game_pid = _launch_game(config, options, env)
        if not game_pid:
            return RecordingResult()

        # MODは最初のPresentでFIFOを開き、形式をログに出してから1フレーム目を書く。
        # ffmpegを起動するまで、ゲームはその書き込みで止まって待っている。
        seen_lines = set()
        if wait_for_log_marker(config.log_path, "FrameSync: capture start",
                               timeout=CAPTURE_START_TIMEOUT_SEC, poll_interval=0.1,
                               log_all=True, seen_lines=seen_lines) is None:
            log("ERROR: MODログに 'FrameSync: capture start' が現れませんでした"
                "(このタイトルのMODがフレーム同期キャプチャに未対応の可能性があります)")
            return RecordingResult()
        width, height, pix_fmt = _CAPTURE_START_RE.search(_read_log(config)).groups()
        width, height = int(width), int(height)

        detection = _build_detection(config, (0, 0, width, height))

        video_cmd = _build_video_cmd(config, options, width, height, pix_fmt, poll_raw_path,
                                     video_path)
        log(f"録画開始(フレーム同期): {' '.join(video_cmd)}")
        video_log_path = f"{options.output_dir}/ffmpeg.log"
        video_log_file = open(video_log_path, "wb")
        video_proc = subprocess.Popen(
            video_cmd, env=env, stdin=subprocess.DEVNULL,
            stdout=video_log_file, stderr=subprocess.STDOUT)
        capture_real_start = time.time()

        if wait_for_log_marker(config.log_path, "sequence complete",
                               timeout=max(MOD_MARKER_TIMEOUT_SEC + 30.0, 300.0),
                               poll_interval=0.1, log_all=True, seen_lines=seen_lines) is None:
            log("WARNING: MODのキーシーケンス完了ログが検出できませんでした")
        unthrottle_real = time.time()
        m = _UNTHROTTLED_RE.search(_read_log(config))
        unthrottle_frame = int(m.group(1)) if m else None
        # リプレイ再生開始時点のサブ出力の枚数を、動画上の位置の基準にする(ffmpegの出力の
        # 遅れのぶん少なめに出るが、猶予の起点が少し手前になるだけで害は無い)。
        start_number = _poll_frame_count(poll_raw_path)
        log(f"リプレイ再生開始(上限解除 frame={unthrottle_frame}、サブ出力{start_number}枚目)。"
            f"動画上で{POST_START_GRACE_SEC:.0f}秒の猶予のあと終了検知を始めます")

        detected_by, content_end_video_sec, poll_log = _monitor_until_end(
            options, detection, video_proc, poll_raw_path, start_number,
            grace_video_sec=POST_START_GRACE_SEC, timeout_sec=TIMEOUT_SEC,
            consecutive_still_required=STILL_CONSECUTIVE_REQUIRED,
            consecutive_template_required=END_TEMPLATE_CONSECUTIVE_REQUIRED)
        stop_request_real = time.time()

        # 停止: MODに取り込みを止めさせてFIFOを閉じさせ、こちらも閉じてffmpegにEOFを届ける。
        frames_written = None
        if video_proc.poll() is None:
            open(stop_path(config), "w").close()
            if wait_for_log_marker(config.log_path, "FrameSync: capture stopped", timeout=20.0,
                                   poll_interval=0.1, seen_lines=seen_lines) is not None:
                frames_written = int(_CAPTURE_STOPPED_RE.search(_read_log(config)).group(1))
            else:
                log("WARNING: MODが取り込みの停止を報告しませんでした")
        os.close(pipe_fd)
        pipe_fd = None
        if frames_written is not None:
            try:
                video_proc.wait(timeout=180)
            except subprocess.TimeoutExpired:
                log("WARNING: ffmpegがEOFで終了しなかったためSIGINTを送ります")
        if video_proc.poll() is None:
            video_proc.send_signal(signal.SIGINT)
            try:
                video_proc.wait(timeout=30)
            except subprocess.TimeoutExpired:
                video_proc.terminate()
                video_proc.wait(timeout=10)
        log(f"ffmpeg(映像) exit_code={video_proc.returncode}")

        video_exists = os.path.exists(video_path)
        video_frames = _count_video_frames(video_path, env) if video_exists else None
        video_sec = (video_frames or 0) / NATIVE_FRAME_RATE_HZ
        if not video_exists:
            with open(video_log_path, "rb") as f:
                log(f"ffmpegログ(末尾): {f.read()[-3000:].decode(errors='replace')}")

        frames_match = frames_written is not None and frames_written == video_frames
        log(f"[FRAME_SYNC] MODが書いたフレーム数={frames_written} 動画のフレーム数={video_frames} "
            f"一致={'OK' if frames_match else 'NG'}")
        if with_audio:
            audio_bytes = os.path.getsize(raw_path) if os.path.exists(raw_path) else 0
            audio_frames = audio_bytes // AUDIO_BYTES_PER_VIDEO_FRAME
            audio_match = (audio_bytes % AUDIO_BYTES_PER_VIDEO_FRAME == 0
                           and audio_frames == video_frames)
            log(f"[FRAME_SYNC] 音声: {audio_bytes}バイト = {audio_frames}フレームぶん"
                f"(端数{audio_bytes % AUDIO_BYTES_PER_VIDEO_FRAME}バイト) 映像との一致="
                f"{'OK' if audio_match else 'NG'}")
            frames_match = frames_match and audio_match
            if video_exists and audio_bytes and _mux_audio(video_path, raw_path, options.output, env):
                if os.environ.get("FRAME_SYNC_KEEP_INTERMEDIATE") != "1":
                    os.remove(video_path)
                    os.remove(raw_path)
        output_exists = os.path.exists(options.output)
        if output_exists:
            log(f"出力ファイルサイズ: {os.path.getsize(options.output)} bytes")
        if unthrottle_frame is not None and frames_written is not None:
            play_frames = frames_written - unthrottle_frame
            play_real = stop_request_real - unthrottle_real
            log(f"[FRAME_SYNC] 上限解除後: {play_frames}フレーム(動画{play_frames / 60:.1f}秒)を"
                f"実時間{play_real:.1f}秒で処理 = 平均{play_frames / 60 / play_real:.2f}倍速"
                f"({play_frames / play_real:.1f}fps)")
        log(f"[FRAME_SYNC] 全体: 動画{video_sec:.1f}秒、録画の実時間"
            f"{stop_request_real - capture_real_start:.1f}秒")
        if content_end_video_sec is not None:
            log(f"content_end_video_sec={content_end_video_sec:.3f}")
        log(f"poll_log(video_sec, MAD): {poll_log}")

        if os.path.exists(poll_raw_path):
            os.remove(poll_raw_path)

        detected = detected_by in ("still", "template")
        if detected_by is None:
            classification, stop_reason = "timeout", "タイムアウトまたは異常終了"
        elif not frames_match:
            # フレーム数が合わない録画は、この方式の前提(1 Present = 1フレーム)が崩れている。
            classification, stop_reason = "setup_error", "フレーム数の不一致"
        else:
            classification = "good"
            stop_reason = {"still": "画面静止検知", "template": "リプレイ選択画面テンプレート照合",
                           "record_seconds": "record-seconds"}[detected_by]
        log(f"録画終了。検知方式: {stop_reason}")
        log(f"出力ファイル: {options.output}")
        return RecordingResult(
            classification=classification,
            detected=detected,
            detected_by=detected_by if detected else None,
            quick_good=(detected_by == "record_seconds" and frames_match),
            # runner側は「動画の長さ」として使うので、実時間ではなく動画の秒数を入れる。
            total_record_sec=video_sec,
            stop_reason=stop_reason,
            output_exists=output_exists,
            end_detect_tail_sec=(
                0.0 if not detected
                else SAMPLE_INTERVAL_VIDEO_SEC * (
                    END_TEMPLATE_CONSECUTIVE_REQUIRED if detected_by == "template"
                    else STILL_CONSECUTIVE_REQUIRED)),
        )
    finally:
        # 通常の録画と同じく、どこで例外が起きてもwineserver/winedeviceを残さない(reports/55)。
        # 先に録画側の読み口を閉じる(ゲームが死んでいる場合、ffmpegがFIFOの読み出しで
        # 待ち続けないようにEOFを届ける)。
        if pipe_fd is not None:
            os.close(pipe_fd)
        if video_proc is not None and video_proc.poll() is None:
            video_proc.send_signal(signal.SIGINT)
            try:
                video_proc.wait(timeout=20)
            except subprocess.TimeoutExpired:
                video_proc.kill()
        if video_log_file is not None:
            video_log_file.close()
        kill_wine_and_wait(config, env)
        for path in (pipe_path(config), stop_path(config)):
            try:
                os.remove(path)
            except FileNotFoundError:
                pass
