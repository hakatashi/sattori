"""フレーム同期キャプチャの録画経路(Issue #389、`CAPTURE_MODE=frame_sync`)。

実時間の経路(`recording/pipeline.py`)は、ゲームを実時間で動かして外からx11grabで取り込み、
音声はPulseAudioから録る。こちらは**MOD(`mods/present/capture/`)がゲームのPresentごとに
バックバッファを読み出してFIFOへ書き、ffmpegがそれを`rawvideo`として読む**。FIFOが詰まると
ゲームの書き込みがブロックするので、描画とエンコードの遅いほうが律速になり、ゲームは可変速で
進む。音声もMOD内の仮想ミキサ(`mods/audio/virtual/`)が映像の1フレームにつき735サンプルを
ファイルへ書き、録画後に結合する(touhou-recorder reports/104〜112、移植元は同`recorder/framesync.py`)。

実時間の経路との違い(分岐の基準は`CAPTURE_MODE`だけ。タイトルや割り当て先では分けない):

  - **時間の基準は動画のフレーム番号**。終了検知の猶予・連続一致・カット位置は動画の秒で数える。
    終了検知用のサブ出力は動画の1秒につき`POLL_STREAM_FPS`枚で、k枚目は必ず動画のk/8秒の画面。
  - **ウィンドウ座標・x11grab・PulseAudio・同期マーカーは使わない**(Xvfbはゲームの起動に要る)。
  - **重複フレーム率による合否判定はしない**。取りこぼしが原理的に起きず、mpdecimateが拾うのは
    ゲームが同じ絵を2回Presentした場面(会話・暗転)だけになる。代わりに次の2つで判定する。
      1. 三者照合: MODが書いたフレーム数 == 動画のフレーム数 == 音声のフレーム数(`check_frame_counts()`)
      2. 理論尺との比較: リプレイのframeCountから求めた尺とのずれ(`check_expected_duration()`)
  - **ワーカーの中ではリトライしない**。決定的なので、同じ条件でやり直しても結果は変わらない。
    失敗はそのままStep Functionsの判断に任せる(`record_frame_sync()`は1回だけ試す)。
  - **ハング検知は実時間**: サブ出力が`STALL_TIMEOUT_SEC`実時間のあいだ増えなければ打ち切る。
    **録画の上限は固定の`MAX_WALL_CLOCK_TIMEOUT_SEC`(120分)**。実時間の経路の
    `min(TIMEOUT_SEC * time_scale, MAX_WALL_CLOCK_TIMEOUT_SEC)`はtime_scale=1で60分になり、
    2xlarge帯でth20の長いリプレイを録るとこれに当たるため使わない(Epic #399)。

Wineのクラッシュ検知(`pipeline.WINE_UNHANDLED_EXCEPTION_MARKER`)・スコアによるデシンク検知・
スコア0の検知は実時間の経路と同じものをそのまま使う。
"""
import fcntl
import math
import os
import signal
import subprocess
import time
from dataclasses import dataclass, field

import numpy as np
from PIL import Image

from . import modlog
from .artifacts import (
    save_diagnostics_snapshot,
    save_progress_snapshot,
    write_cut_result,
    write_desync_result,
    write_timeout_result,
)
from .cut import compute_frame_sync_cut_range
from .modlog import check_replay_desync, is_score_zero, read_verified_scores, wait_for_log_marker
from .pipeline import (
    END_TEMPLATE_CONSECUTIVE_REQUIRED,
    FREEZE_CONSECUTIVE_REQUIRED,
    MAX_WALL_CLOCK_TIMEOUT_SEC,
    POLL_INTERVAL_SEC,
    POST_START_GRACE_SEC,
    STILL_CONSECUTIVE_REQUIRED,
    WINE_UNHANDLED_EXCEPTION_MARKER,
    _launch_game,
    _log_failure_diagnostics,
    build_end_detection,
)
from .process import attach_thprac, kill_wine_and_wait
from .sync_marker import windows_path
from .timing import NATIVE_FRAME_RATE_HZ
from .vision import STILL_MAD_THRESHOLD, load_end_template, mad_masked
from .window import find_window

# FIFOのバッファ。既定の64KiBでは1フレーム(1280x960で約4.9MB)の受け渡しに往復が多いので、
# 非特権で設定できる上限(/proc/sys/fs/pipe-max-size の既定値)まで広げる。
PIPE_BUFFER_BYTES = 1 << 20
# 1MiBを設定できないとき(`/proc/sys/fs/pipe-user-pages-soft`、ユーザー単位のパイプバッファの
# 総量の上限を超えるとEPERMになる。コンテナはCAP_SYS_RESOURCEを持たず、ホストのrootの他のプロセスや
# 並列録画のコンテナ(自宅ワーカー)が先に使い切っていることがある)に、段階的に小さくして試す。
# 全部だめなら既定の64KiBのまま続ける(遅くなるだけで録画はできる)。
PIPE_BUFFER_FALLBACK_BYTES = (1 << 19, 1 << 18, 1 << 17)
_F_SETPIPE_SZ = 1031

# 終了検知用サブ出力の形式(160x120 gray、動画の1秒につきPOLL_STREAM_FPS枚)。
POLL_FRAME_W = 160
POLL_FRAME_H = 120
POLL_STREAM_FPS = 8
# 終了検知のサンプリング間隔(動画の秒)。実時間の経路の`POLL_INTERVAL_SEC`に相当する。
SAMPLE_INTERVAL_VIDEO_SEC = POLL_INTERVAL_SEC
# 進捗・診断用のカラーのプレビュー(480px幅のJPEG)を作る間隔(動画の秒)。
PREVIEW_INTERVAL_VIDEO_SEC = 2.0
PREVIEW_WIDTH = 480
# 進捗スナップショットを書き出す実時間の間隔(秒)。実時間の経路は約10秒おき。
PROGRESS_WRITE_INTERVAL_SEC = 5.0

# サブ出力がこの実時間のあいだ1枚も増えなければ、ゲームが止まったとみなして打ち切る。
STALL_TIMEOUT_SEC = 120.0
# 最初のフレームの形式がMODログに出るまでの待ち(ゲームの起動からデバイス作成まで)。
CAPTURE_START_TIMEOUT_SEC = 60.0
# `sequence complete`(メニュー操作の完了)の待ち。メニュー区間はゲームが実時間60Hzで進み、
# タイトル(th06nc・th20等)によってロードと待機で数十秒かかる。実時間の経路のタイムアウト
# (20秒)より長く取る。
SEQUENCE_COMPLETE_TIMEOUT_SEC = 300.0
# 取り込みの停止要求から`capture stopped`が出るまでの待ち。
CAPTURE_STOP_TIMEOUT_SEC = 20.0
# MODが書き終えたあと、ffmpegがEOFを受けてエンコードを終えるまでの待ち。
FFMPEG_DRAIN_TIMEOUT_SEC = 300.0

# 録画の上限。実時間の経路のように`TIMEOUT_SEC * time_scale`を経由せず固定にする(モジュール docstring)。
RECORDING_TIMEOUT_SEC = MAX_WALL_CLOCK_TIMEOUT_SEC

# 仮想音声デバイスが書くPCMの形式(`mods/audio/virtual/`)。
AUDIO_RATE_HZ = 44100
AUDIO_BYTES_PER_VIDEO_FRAME = AUDIO_RATE_HZ // 60 * 2 * 2  # 735サンプル × 2ch × 16bit

# 理論尺(リプレイのframeCountから求めた`EXPECTED_DURATION_SECONDS`)とのずれの許容。**録画が理論尺より
# 短い側は広く、長い側は狭く取る**。リプレイパーサーのframeCountは、th06・th07・th08で実際のプレイ時間と
# 系統的にずれる(多くは理論尺のほうが長い)ため。実測(再生区間/理論尺):
#   - th12・th15・th13・th20・th09・th10・th11・th128・th06c・th06nc: -0.5〜+0.6%
#   - th07: -3.9%、th08: -4.95%、th06: -2.1・-2.4・-5.65%(TR reports/111)
#   - **th06の1本(Extra/MarisaB、理論862秒)は-14.2%**。同じリプレイを実時間の経路で録ると総録画時間が
#     753.8秒(フレーム同期は757.7秒)で、スコアも最終まで一致したので、録画は正しくパーサーの値が長すぎる
#     (docs/reports/2026-11-22-worker-frame-sync-full-length-verification.md)。
# 録画が正しいのに破棄するのは、取りこぼしのない録画を捨ててジョブを別の段へ回すだけなので、短い側は
# 30%まで許す(リプレイが再生されなかった・途中で止まった録画は-100%〜大幅な短縮になる)。
DURATION_TOLERANCE_SHORTER_RATIO = 0.30
DURATION_TOLERANCE_LONGER_RATIO = 0.10
# 短いリプレイでは割合だけでは厳しすぎるので、絶対値(秒)の下限も置く。
DURATION_TOLERANCE_MIN_SEC = 3.0

# 診断スナップショット(`artifacts.save_diagnostics_snapshot()`)のファイル名に使う分類。
# 実時間の経路の"duplicate_rate"・"score_zero"と同じく、結果の`classification`とは別の
# 「なぜ破棄したか」を表す。
DIAG_FRAME_MISMATCH = "frame_mismatch"
DIAG_DURATION_MISMATCH = "duration_mismatch"


# ---------------------------------------------------------------------------
# パス
# ---------------------------------------------------------------------------
def pipe_path(config):
    return f"{config.instance_dir}/framesync.fifo"


def stop_path(config):
    return f"{config.instance_dir}/framesync.stop"


def _intermediate_paths(output_path):
    """録画中の中間ファイル(出力先と同じディレクトリ。mux後に消す)。"""
    base, _ext = os.path.splitext(output_path)
    return {
        "video": f"{base}.video.mp4",
        "audio": f"{base}.audio.pcm",
        "poll": f"{base}.pollstream.raw",
        "preview": f"{base}.preview.jpg",
    }


# ---------------------------------------------------------------------------
# 純粋な判定・換算(ユニットテストの対象)
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class FrameCounts:
    """三者照合の結果。"""

    frames_written: int | None  # MODが書いたフレーム数(MODログ)
    video_frames: int | None  # 動画のフレーム数(ffprobe)
    audio_frames: int | None  # 音声のフレーム数(PCMのバイト数 / 2940)
    audio_remainder_bytes: int  # PCMの端数(0でなければならない)

    @property
    def ok(self):
        return (
            self.frames_written is not None
            and self.video_frames is not None
            and self.audio_remainder_bytes == 0
            and self.frames_written == self.video_frames == self.audio_frames
        )

    def describe(self):
        return (
            f"MODが書いたフレーム数={self.frames_written} 動画のフレーム数={self.video_frames} "
            f"音声のフレーム数={self.audio_frames}(PCMの端数{self.audio_remainder_bytes}バイト)"
        )


def check_frame_counts(frames_written, video_frames, audio_bytes):
    """三者照合: MODが書いたフレーム数・動画のフレーム数・音声のフレーム数が一致するか。

    フレーム同期の前提は「1 Present = 動画の1フレーム = 音声の735サンプル」で、これが崩れた録画は
    映像と音声がずれており使えない。PCMの大きさはちょうど「映像フレーム数 × 2940バイト」でなければ
    ならない(端数があれば音声の書き出しが途中で切れている)。"""
    return FrameCounts(
        frames_written=frames_written,
        video_frames=video_frames,
        audio_frames=audio_bytes // AUDIO_BYTES_PER_VIDEO_FRAME,
        audio_remainder_bytes=audio_bytes % AUDIO_BYTES_PER_VIDEO_FRAME,
    )


def play_duration_sec(content_end_sec, replay_start_frame):
    """リプレイの再生区間の長さ(秒)。終了検知の位置から、リプレイの再生を始めたフレームを引く。

    再生を始めたフレームは、再生を確定するキーを押した位置(`modlog.find_frame_sync_replay_start_frame()`)で、
    上限を解除したフレームではない。th06等はそのあとのロード待ち(実時間約10秒、再生は始まっている)を
    挟んでから上限を解除するので、解除の位置を使うと再生区間がその分短く出る。"""
    if content_end_sec is None or replay_start_frame is None:
        return None
    return content_end_sec - replay_start_frame / NATIVE_FRAME_RATE_HZ


def check_expected_duration(play_sec, expected_sec):
    """理論尺とのずれが許容内か。戻り値: (ok, ずれの割合 or None)。

    どちらかが分からなければ判定できないので(True, None)。許容は、短い側が`DURATION_TOLERANCE_SHORTER_RATIO`、
    長い側が`DURATION_TOLERANCE_LONGER_RATIO`(どちらも`DURATION_TOLERANCE_MIN_SEC`を下限とする)。"""
    if play_sec is None or not expected_sec or expected_sec <= 0:
        return True, None
    error = play_sec - expected_sec
    ratio = DURATION_TOLERANCE_SHORTER_RATIO if error < 0 else DURATION_TOLERANCE_LONGER_RATIO
    tolerance = max(expected_sec * ratio, DURATION_TOLERANCE_MIN_SEC)
    return abs(error) <= tolerance, error / expected_sec


def progress_seconds(poll_frames, start_poll_frame):
    """録画済みのリプレイの尺(秒)。**動画のフレーム数が基準**(実時間ではない)で、メニュー区間を除く。

    実時間の経路は`elapsed / time_scale`(リプレイ再生開始からの実時間をコンテンツ秒数へ戻した値)を
    報告している。こちらはサブ出力の枚数(動画の1秒につき`POLL_STREAM_FPS`枚)から求める。"""
    return max(0.0, (poll_frames - start_poll_frame) / POLL_STREAM_FPS)


def start_poll_number(unthrottled_frame, fallback):
    """リプレイ再生開始時点のサブ出力の枚数(動画上の位置の基準)。

    上限を解除したフレーム番号から決定論的に求める(ffmpegの出力の遅れに依らない)。
    ログに無ければ`fallback`(その時点のサブ出力の枚数)。"""
    if unthrottled_frame is None:
        return fallback
    return math.ceil(unthrottled_frame * POLL_STREAM_FPS / NATIVE_FRAME_RATE_HZ)


# ---------------------------------------------------------------------------
# FIFO・ffmpeg
# ---------------------------------------------------------------------------
def _open_pipe(config, log):
    """FIFOを作り、読み書き両用で開いておく。

    録画側が読み口を持ち続けることで、(1) ffmpegの起動前でもMODがFIFOを開ける、(2) バッファを
    広げた設定がFIFOの寿命のあいだ保たれる。ffmpegにEOFを届けるには、MODが閉じたあとで
    このfdも閉じる必要がある。
    """
    os.makedirs(config.instance_dir, exist_ok=True)
    for path in (pipe_path(config), stop_path(config)):
        try:
            os.remove(path)
        except FileNotFoundError:
            pass
    os.mkfifo(pipe_path(config))
    fd = os.open(pipe_path(config), os.O_RDWR)
    size = _grow_pipe_buffer(fd, log)
    log(f"フレーム同期用FIFOを作成しました ({pipe_path(config)}, バッファ{size}バイト)")
    return fd


def _grow_pipe_buffer(fd, log):
    """FIFOのバッファを`PIPE_BUFFER_BYTES`へ広げる。設定できなければ小さい値から順に試し、
    全部だめなら既定のまま使う。戻り値は実際のバッファの大きさ。"""
    for requested in (PIPE_BUFFER_BYTES, *PIPE_BUFFER_FALLBACK_BYTES):
        try:
            return fcntl.fcntl(fd, _F_SETPIPE_SZ, requested)
        except PermissionError:
            log(f"WARNING: FIFOのバッファを{requested}バイトへ広げられませんでした"
                "(pipe-user-pages-softの上限)。より小さい値を試します")
    log("WARNING: FIFOのバッファを広げられなかったため、既定の大きさのまま録画します"
        "(フレームの受け渡しの往復が増え、録画が遅くなりうる)")
    return fcntl.fcntl(fd, 1032)  # F_GETPIPE_SZ


def build_video_cmd(config, width, height, pix_fmt, paths):
    """FIFOからrawvideoを読んでエンコードするffmpegコマンド。

    出力は3つ:
      - 本出力: 実時間の経路の生動画と同じ`libx264 -preset veryfast -crf 18 -pix_fmt yuv420p`
        (`ffmpeg._video_encoder_args()`)。配信用変換(`convert.py`)が1パスで再エンコードするので、
        ここは今の本番の生動画と同じ設定に揃える。
      - 終了検知用のサブ出力: 160x120 gray、動画の1秒につき`POLL_STREAM_FPS`枚のrawvideo。入力の
        タイムスタンプが動画のフレーム番号から決まるので、k枚目は必ず動画のk/POLL_STREAM_FPS秒の画面。
      - 進捗・診断用のカラーのプレビュー(JPEG、同じファイルを上書き)。
    """
    return [
        "ffmpeg", "-y", "-nostdin",
        "-f", "rawvideo", "-pix_fmt", pix_fmt, "-video_size", f"{width}x{height}",
        "-framerate", f"{NATIVE_FRAME_RATE_HZ:g}", "-i", pipe_path(config),
        "-filter_complex",
        "[0:v]split=3[vmain][vpollsrc][vprevsrc];"
        f"[vpollsrc]fps={POLL_STREAM_FPS:g},scale={POLL_FRAME_W}:{POLL_FRAME_H},format=gray[vpollout];"
        f"[vprevsrc]fps={1.0 / PREVIEW_INTERVAL_VIDEO_SEC:g},scale={PREVIEW_WIDTH}:-2[vprevout]",
        "-map", "[vmain]",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
        paths["video"],
        "-map", "[vpollout]", "-f", "rawvideo", "-pix_fmt", "gray", "-flush_packets", "1",
        paths["poll"],
        "-map", "[vprevout]", "-f", "image2", "-update", "1", "-atomic_writing", "1",
        "-qscale:v", "5", paths["preview"],
    ]


def build_mux_cmd(video_path, audio_path, output_path):
    """映像と仮想音声のPCMを結合する(映像は再エンコードなし)。両者は同じフレーム数なので位置合わせは要らない。"""
    return [
        "ffmpeg", "-y", "-nostdin", "-v", "error", "-i", video_path,
        "-f", "s16le", "-ar", str(AUDIO_RATE_HZ), "-ac", "2", "-i", audio_path,
        "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart", output_path,
    ]


def _count_video_frames(path, env):
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-count_packets",
         "-show_entries", "stream=nb_read_packets", "-of", "csv=p=0", path],
        env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True)
    try:
        return int(r.stdout.strip().split(",")[0])
    except (ValueError, IndexError):
        return None


def _poll_frame_count(path):
    try:
        return os.stat(path).st_size // (POLL_FRAME_W * POLL_FRAME_H)
    except OSError:
        return 0


def _read_poll_frame_at(path, number):
    """サブ出力のnumber枚目(1始まり)を読む。まだ書き切られていなければNone。"""
    size = POLL_FRAME_W * POLL_FRAME_H
    try:
        with open(path, "rb") as f:
            f.seek((number - 1) * size)
            buf = f.read(size)
    except OSError:
        return None
    if len(buf) < size:
        return None
    return np.frombuffer(buf, dtype=np.uint8).reshape(POLL_FRAME_H, POLL_FRAME_W).astype(np.float32)


def _read_preview(path):
    """進捗・診断用のカラーのプレビューを読む。無い・書きかけならNone。"""
    try:
        with Image.open(path) as img:
            return img.convert("RGB")
    except (OSError, ValueError):
        return None


# ---------------------------------------------------------------------------
# 終了検知
# ---------------------------------------------------------------------------
@dataclass
class _Monitor:
    """`_monitor_until_end()`の結果。"""

    detected: bool = False
    detected_by: str | None = None  # "template" / "still"
    frozen: bool = False
    crashed: bool = False
    stalled: bool = False  # サブ出力が実時間でSTALL_TIMEOUT_SEC増えなかった
    ffmpeg_exited: bool = False
    timed_out: bool = False
    # 終了を確定させた連続一致が始まったサブ出力の位置(動画の秒)。detectedでなければNone。
    content_end_sec: float | None = None
    poll_log: list = field(default_factory=list)


def _check_wine_crash(wine_log_path, offset, log):
    """wine.logの増分にWineの未処理例外があるか。戻り値: (クラッシュしたか, 新しい既読位置)。"""
    try:
        size = os.path.getsize(wine_log_path)
    except OSError:
        return False, offset
    if size <= offset:
        return False, offset
    try:
        with open(wine_log_path, "r", errors="replace") as f:
            f.seek(offset)
            new = f.read()
    except OSError:
        return False, offset
    if WINE_UNHANDLED_EXCEPTION_MARKER in new:
        log(
            "ERROR: wine.log にWineの未処理例外を検知しました"
            "(ゲームプロセスのクラッシュ、Issue #267)。録画を打ち切ります\n"
            f"--- wine.log 新規出力 ---\n{new.strip()}"
        )
        return True, size
    return False, size


def _monitor_until_end(config, detection, video_proc, paths, start_number, *,
                       progress_dir, expected_duration_seconds, log,
                       timeout_sec=RECORDING_TIMEOUT_SEC, stall_timeout_sec=STALL_TIMEOUT_SEC,
                       clock=time.time, sleep=time.sleep):
    """リプレイ終了(または異常)を検知するまで、サブ出力を**動画の時間で**一定間隔に調べる。

    実時間の経路の`pipeline._monitor_until_end()`のフレーム同期版。違いは時間の数え方で、
    猶予(`POST_START_GRACE_SEC`)・連続一致の回数・画面固着(`FREEZE_CONSECUTIVE_REQUIRED`)はいずれも
    `time_scale`倍せず、動画の秒(サブ出力の枚数)で数える。実時間で数えるのは**上限
    (`timeout_sec`)とハング検知(`stall_timeout_sec`)だけ**。

    判定の優先順位は実時間の経路と同じ: Wineのクラッシュ > テンプレート照合/画面静止。
    """
    stride = round(SAMPLE_INTERVAL_VIDEO_SEC * POLL_STREAM_FPS)
    next_number = start_number + round(POST_START_GRACE_SEC * POLL_STREAM_FPS)
    still_required = STILL_CONSECUTIVE_REQUIRED
    template_required = END_TEMPLATE_CONSECUTIVE_REQUIRED
    freeze_required = FREEZE_CONSECUTIVE_REQUIRED
    result = _Monitor()
    prev_frame = None
    prev_number = None
    streak_start_number = None
    consecutive_still = 0
    consecutive_template = 0
    consecutive_freeze = 0
    wine_log_path = f"{config.instance_dir}/wine.log"
    wine_log_offset = os.path.getsize(wine_log_path) if os.path.exists(wine_log_path) else 0
    real_start = clock()
    last_growth = (real_start, _poll_frame_count(paths["poll"]))
    last_progress_write = 0.0

    while True:
        now = clock()
        if now - real_start > timeout_sec:
            log(f"TIMEOUT: 実時間{timeout_sec:.0f}秒経過したため強制停止します")
            result.timed_out = True
            return result
        if video_proc.poll() is not None:
            log(f"ERROR: 録画用ffmpegが終了しています (returncode={video_proc.returncode})")
            result.ffmpeg_exited = True
            return result
        crashed, wine_log_offset = _check_wine_crash(wine_log_path, wine_log_offset, log)
        if crashed:
            result.crashed = True
            return result

        available = _poll_frame_count(paths["poll"])
        if available != last_growth[1]:
            last_growth = (now, available)
        elif now - last_growth[0] > stall_timeout_sec:
            log(f"ERROR: {stall_timeout_sec:.0f}秒間フレームが届いていません。ゲームが止まったと"
                "みなして中止します")
            result.stalled = True
            return result

        if progress_dir and now - last_progress_write >= PROGRESS_WRITE_INTERVAL_SEC:
            preview = _read_preview(paths["preview"])
            if preview is not None:
                last_progress_write = now
                save_progress_snapshot(
                    progress_dir, preview, progress_seconds(available, start_number),
                    expected_duration_seconds,
                )

        if available < next_number:
            sleep(0.1)
            continue
        frame = _read_poll_frame_at(paths["poll"], next_number)
        if frame is None:
            sleep(0.1)
            continue
        video_sec = next_number / POLL_STREAM_FPS
        real_sec = now - real_start
        speed = (next_number - start_number) / POLL_STREAM_FPS / real_sec if real_sec > 0 else 0.0

        if detection.template is not None:
            # テンプレートが使えるゲームは、画面静止を待たずに毎回テンプレート照合する
            # (docs/decisions/0011)。画面固着だけは別に見る(docs/decisions/0039)。
            d = mad_masked(frame, detection.template, detection.template_mask)
            if d < detection.template_mad_threshold:
                if consecutive_template == 0:
                    streak_start_number = next_number
                consecutive_template += 1
            else:
                consecutive_template = 0
            result.poll_log.append((round(video_sec, 1), round(d, 2)))
            log(f"poll: video={video_sec:.1f}s real={real_sec:.1f}s 平均{speed:.2f}倍速 "
                f"template_MAD={d:.2f} end_template_consecutive={consecutive_template}")
            if consecutive_template >= template_required:
                log("リプレイ選択画面と連続して一致したためリプレイ終了と判定しました")
                result.detected, result.detected_by = True, "template"
                result.content_end_sec = streak_start_number / POLL_STREAM_FPS
                return result
            if prev_frame is not None:
                if mad_masked(prev_frame, frame, detection.still_mask) < STILL_MAD_THRESHOLD:
                    consecutive_freeze += 1
                else:
                    consecutive_freeze = 0
                if consecutive_freeze >= freeze_required:
                    log(f"WARNING: 画面が動画の{freeze_required * SAMPLE_INTERVAL_VIDEO_SEC / 60:.0f}"
                        "分間静止したままのため強制停止します")
                    result.frozen = True
                    return result
        elif prev_frame is not None:
            d = mad_masked(prev_frame, frame, detection.still_mask)
            if d < STILL_MAD_THRESHOLD:
                if consecutive_still == 0:
                    # 静止は前回のサンプルの時点で既に始まっている。
                    streak_start_number = prev_number
                consecutive_still += 1
            else:
                consecutive_still = 0
            result.poll_log.append((round(video_sec, 1), round(d, 2)))
            log(f"poll: video={video_sec:.1f}s real={real_sec:.1f}s 平均{speed:.2f}倍速 "
                f"MAD={d:.2f} still={consecutive_still}")
            if consecutive_still >= still_required:
                log("画面が一定時間変化しなくなったためリプレイ終了と判定しました")
                result.detected, result.detected_by = True, "still"
                result.content_end_sec = streak_start_number / POLL_STREAM_FPS
                return result
        prev_frame = frame
        prev_number = next_number
        next_number += stride


# ---------------------------------------------------------------------------
# 1回の試行
# ---------------------------------------------------------------------------
def _frame_sync_env(config, paths):
    """フレーム同期用の環境変数(MODはWine内から開くのでWindows形式のパスで渡す)。"""
    env = config.build_env()
    # 倍速・低速録画と同期マーカーの仕組みは使わない(フレーム同期とは併用できない)。
    for name in ("FPS_LIMIT_TARGET_HZ", "SPEED_HACK_MULTIPLIER", "SYNC_MARKER_TRIGGER"):
        env.pop(name, None)
    env["FRAME_SYNC_PIPE"] = windows_path(pipe_path(config))
    env["FRAME_SYNC_STOP"] = windows_path(stop_path(config))
    env["FRAME_SYNC_AUDIO"] = windows_path(paths["audio"])
    return env


def _attach_thprac_after_window(config, env, game_pid, log):
    """thpracを設定したタイトル(th20)は、ゲームウィンドウが出現してからアタッチする
    (`process.attach_thprac()`参照)。フレーム同期はウィンドウ座標を使わないので、ここでは
    出現を待つだけ。失敗しても録画は続行する(thprac無しの従来動作に戻るだけ)。"""
    if not config.thprac_exe:
        return
    t0 = time.time()
    while time.time() - t0 < 20:
        if find_window(config, env, game_pid):
            break
        time.sleep(0.1)
    else:
        log("WARNING: thpracをアタッチする前にゲームウィンドウを検出できませんでした")
    attach_thprac(config, env, log=log)


def _stop_capture(config, pipe_fd, video_proc, seen_lines, log):
    """MODに取り込みを止めさせ、FIFOの両端を閉じてffmpegにEOFを届ける。

    `pipe_fd`はここで閉じる(呼び出し側は以後使わない)。戻り値はMODが書いたフレーム数(報告が無ければNone)。"""
    frames_written = None
    if video_proc.poll() is None:
        open(stop_path(config), "w").close()
        if wait_for_log_marker(
            config.log_path, modlog.FRAME_SYNC_CAPTURE_STOPPED_LOG, timeout=CAPTURE_STOP_TIMEOUT_SEC,
            poll_interval=0.1, seen_lines=seen_lines, log=log,
        ) is not None:
            frames_written = modlog.read_frame_sync_frames_written(config.log_path)
        else:
            log("WARNING: MODが取り込みの停止を報告しませんでした")
    os.close(pipe_fd)
    if frames_written is not None:
        try:
            video_proc.wait(timeout=FFMPEG_DRAIN_TIMEOUT_SEC)
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
    return frames_written


def attempt_recording_frame_sync(config, replay_path, output_path, progress_dir,
                                 expected_duration_seconds, log=print):
    """フレーム同期キャプチャで1回だけ録画を試みる。プロセスの後片付けまで含めて完結する。

    戻り値は実時間の経路の`attempt_recording()`と同じ形のdict(`output_exists`・`classification`
    ("good"/"crashed"/"timeout"/"setup_error")・`total_record_sec`(動画の秒)・`cut`・`time_scale`)に、
    フレーム同期用の`counts`(`FrameCounts`)・`play_sec`・`detected`・`last_preview`を足したもの。
    """
    paths = _intermediate_paths(output_path)
    env = _frame_sync_env(config, paths)
    end_template = load_end_template(config.end_template_path)
    if end_template is None:
        log(
            f"WARNING: {config.end_template_path} が見つからないため、画面静止のみで"
            "リプレイ終了を判定します(誤検知の可能性あり、reports/33参照)"
        )
    for path in (*paths.values(), output_path):
        if os.path.exists(path):
            os.remove(path)

    def failure(classification="setup_error"):
        return {
            "output_exists": False, "classification": classification, "total_record_sec": 0.0,
            "time_scale": 1.0, "cut": None, "counts": None, "play_sec": None, "detected": False,
            "last_preview": None,
        }

    pipe_fd = None
    video_proc = None
    video_log_file = None
    try:
        pipe_fd = _open_pipe(config, log)
        game_pid = _launch_game(config, env, replay_path, log)
        if not game_pid:
            _log_failure_diagnostics(config, log)
            return failure()
        _attach_thprac_after_window(config, env, game_pid, log)

        # MODは最初のPresentでFIFOを開き、形式をログに出してから1フレーム目を書く。
        # ffmpegを起動するまで、ゲームはその書き込みで止まって待っている。
        seen_lines = set()
        if wait_for_log_marker(
            config.log_path, modlog.FRAME_SYNC_CAPTURE_START_LOG, timeout=CAPTURE_START_TIMEOUT_SEC,
            poll_interval=0.1, log_all=True, seen_lines=seen_lines, log=log,
        ) is None:
            log("ERROR: MODログに 'FrameSync: capture start' が現れませんでした"
                "(このタイトルのMODがフレーム同期キャプチャに未対応の可能性があります)")
            _log_failure_diagnostics(config, log)
            return failure()
        capture = modlog.read_frame_sync_capture_start(config.log_path)
        if capture is None:
            log("ERROR: 'FrameSync: capture start' の行を読み取れませんでした")
            return failure()
        width, height, pix_fmt = capture
        detection = build_end_detection(config, end_template, width, height)

        video_cmd = build_video_cmd(config, width, height, pix_fmt, paths)
        log(f"録画開始(フレーム同期): {' '.join(video_cmd)}")
        video_log_path = f"{os.path.dirname(output_path)}/ffmpeg_video.log"
        video_log_file = open(video_log_path, "wb")
        video_proc = subprocess.Popen(
            video_cmd, env=env, stdin=subprocess.DEVNULL,
            stdout=video_log_file, stderr=subprocess.STDOUT)

        sequence_complete = wait_for_log_marker(
            config.log_path, modlog.SEQUENCE_COMPLETE_LOG, timeout=SEQUENCE_COMPLETE_TIMEOUT_SEC,
            poll_interval=0.1, log_all=True, seen_lines=seen_lines, log=log,
        )
        if sequence_complete is None:
            log("WARNING: MODのキーシーケンス完了ログが検出できませんでした")
        unthrottled_frame = modlog.read_frame_sync_unthrottled_frame(config.log_path)
        start_number = start_poll_number(unthrottled_frame, _poll_frame_count(paths["poll"]))
        log(f"リプレイ再生開始(上限解除 frame={unthrottled_frame}、サブ出力{start_number}枚目)。"
            f"動画の{POST_START_GRACE_SEC:.0f}秒の猶予のあと終了検知を始めます")
        play_real_start = time.time()

        monitor = _monitor_until_end(
            config, detection, video_proc, paths, start_number,
            progress_dir=progress_dir, expected_duration_seconds=expected_duration_seconds, log=log,
        )
        play_real_sec = time.time() - play_real_start
        last_preview = _read_preview(paths["preview"])

        frames_written = _stop_capture(config, pipe_fd, video_proc, seen_lines, log)
        pipe_fd = None

        video_exists = os.path.exists(paths["video"])
        video_frames = _count_video_frames(paths["video"], env) if video_exists else None
        video_sec = (video_frames or 0) / NATIVE_FRAME_RATE_HZ
        if not video_exists:
            video_log_file.flush()
            with open(video_log_path, "rb") as f:
                log(f"ffmpegログ(末尾): {f.read()[-3000:].decode(errors='replace')}")
        audio_bytes = os.path.getsize(paths["audio"]) if os.path.exists(paths["audio"]) else 0
        counts = check_frame_counts(frames_written, video_frames, audio_bytes)
        log(f"[FRAME_SYNC] {counts.describe()} 一致={'OK' if counts.ok else 'NG'}")

        output_exists = False
        if video_exists and audio_bytes:
            output_exists = _mux(paths, output_path, env, log)
        if output_exists:
            log(f"出力ファイル: {output_path} ({os.path.getsize(output_path)} bytes)")
        replay_start_frame = modlog.find_frame_sync_replay_start_frame(config.log_path)
        play_sec = play_duration_sec(
            monitor.content_end_sec,
            replay_start_frame if replay_start_frame is not None else unthrottled_frame)
        if unthrottled_frame is not None and frames_written is not None and play_real_sec > 0:
            play_frames = frames_written - unthrottled_frame
            log(f"[FRAME_SYNC] 上限解除後: {play_frames}フレーム(動画{play_frames / 60:.1f}秒)を"
                f"実時間{play_real_sec:.1f}秒で処理 = 平均{play_frames / 60 / play_real_sec:.2f}倍速"
                f"({play_frames / play_real_sec:.1f}fps)")
        log(f"[FRAME_SYNC] 全体: 動画{video_sec:.1f}秒")
        if monitor.content_end_sec is not None:
            log(f"content_end_sec={monitor.content_end_sec:.3f} (リプレイの再生区間 {play_sec}秒)")
        log(f"poll_log(video_sec, MAD): {monitor.poll_log}")

        cut = None
        if output_exists:
            cut = compute_frame_sync_cut_range(config, monitor.content_end_sec, log=log)

        if monitor.detected:
            classification = "good"
            stop_reason = (
                "リプレイ選択画面テンプレート照合" if monitor.detected_by == "template" else "画面静止検知")
        elif monitor.crashed:
            classification, stop_reason = "crashed", "Wineクラッシュ検知(wine.log)"
        elif monitor.frozen:
            classification, stop_reason = "timeout", "画面固着の早期検知(タイムアウト相当)"
        elif monitor.timed_out:
            classification, stop_reason = "timeout", "タイムアウト"
        elif monitor.stalled:
            classification, stop_reason = "timeout", "ゲームの停止(サブ出力が増えない)"
        else:
            classification, stop_reason = "setup_error", "録画用ffmpegの異常終了"
        if classification in ("good", "timeout") and not counts.ok:
            # 前提(1 Present = 動画の1フレーム)が崩れた録画は、映像と音声がずれていて使えない
            # (打ち切られた録画も、MODが取り込みの停止を報告できなければここに来る)。
            classification = "setup_error"
            stop_reason = "フレーム数の不一致"
        log(f"録画終了。動画{video_sec:.1f}秒 検知方式: {stop_reason}")

        return {
            "output_exists": output_exists,
            "classification": classification,
            # 実時間の経路では実時間の秒だが、こちらは動画の秒(時間の基準がフレーム数のため)。
            "total_record_sec": video_sec,
            "cut": cut,
            "time_scale": 1.0,
            "counts": counts,
            "play_sec": play_sec,
            "detected": monitor.detected,
            "last_preview": last_preview,
        }
    finally:
        # どこで例外が起きてもwineserver/winedeviceを残さない(2026-08-27インシデント)。先に録画側の
        # 読み口を閉じる(ゲームが死んでいる場合、ffmpegがFIFOの読み出しで待ち続けないようにEOFを届ける)。
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
        kill_wine_and_wait(config, env, config.process_name, log=log)
        for path in (pipe_path(config), stop_path(config), paths["poll"], paths["preview"]):
            try:
                os.remove(path)
            except FileNotFoundError:
                pass


def _mux(paths, output_path, env, log):
    """映像と仮想音声のPCMを結合し、成功したら中間ファイルを消す。"""
    cmd = build_mux_cmd(paths["video"], paths["audio"], output_path)
    log(f"音声を結合します: {' '.join(cmd)}")
    r = subprocess.run(cmd, env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True)
    if r.returncode != 0:
        log(f"ERROR: 音声の結合に失敗しました: {r.stderr[-2000:]}")
        return False
    if os.environ.get("FRAME_SYNC_KEEP_INTERMEDIATE") != "1":
        for key in ("video", "audio"):
            os.remove(paths[key])
    return True


# ---------------------------------------------------------------------------
# 合否判定(ワーカーの中ではリトライしない)
# ---------------------------------------------------------------------------
def record_frame_sync(config, replay_path, output_path, *, progress_dir=None,
                      expected_duration_seconds=None, diagnostics_dir=None, expected_score=None,
                      desync_result_path=None, timeout_result_path=None, cut_result_path=None,
                      log=print):
    """フレーム同期キャプチャで録画し、合否を判定する。成功ならTrue。**リトライしない**。

    `pipeline.record_with_retry()`の同等品だが、1回しか試さず、**重複フレーム率の判定は使わない**
    (モジュール docstring)。失敗(False)は`recording.cli.run()`が終了コード1にし、`entrypoint.py`が
    ジョブの失敗として扱ってStep Functionsのリトライ・フォールバックに任せる。
    破棄の理由は診断スナップショット(`attempt1-<分類>.jpg`)とログに残す。
    """
    log("=== フレーム同期キャプチャ(CAPTURE_MODE=frame_sync)。ワーカーの中ではリトライしません ===")
    try:
        result = attempt_recording_frame_sync(
            config, replay_path, output_path, progress_dir, expected_duration_seconds, log=log,
        )
    except Exception as err:  # noqa: BLE001 - 後始末をして失敗として返す
        import traceback
        log(f"ERROR: 想定外の例外が発生しました: {err!r}")
        log(traceback.format_exc())
        try:
            kill_wine_and_wait(config, config.build_env(), config.process_name, log=log)
        except Exception as cleanup_err:  # noqa: BLE001
            log(f"ERROR: 後片付け中にも例外が発生しました: {cleanup_err!r}")
        return False

    def discard(reason, diag):
        log(f"ERROR: {reason}。この録画は破棄します(ワーカーの中ではリトライしません)")
        save_diagnostics_snapshot(diagnostics_dir, result.get("last_preview"), 1, diag)
        return False

    if not result["output_exists"]:
        return discard("出力ファイルが生成されませんでした", result["classification"])
    if result["classification"] == "crashed":
        return discard("録画中にWineがクラッシュしました", "crashed")
    if result["classification"] == "setup_error":
        return discard(
            f"フレーム数が一致しません({result['counts'].describe()})"
            if result["counts"] is not None and not result["counts"].ok
            else "録画を正常に完了できませんでした",
            DIAG_FRAME_MISMATCH if result["counts"] is not None and not result["counts"].ok
            else "setup_error",
        )
    if result["detected"]:
        # 理論尺との比較。終了を検知できなかった(timeout)録画は尺が短くて当然なので対象外。
        ok, error_ratio = check_expected_duration(result["play_sec"], expected_duration_seconds)
        if error_ratio is not None:
            log(f"[FRAME_SYNC] 理論尺との比較: 再生区間{result['play_sec']:.1f}秒 / "
                f"理論{expected_duration_seconds:.1f}秒 = {error_ratio * 100:+.2f}% "
                f"(許容-{DURATION_TOLERANCE_SHORTER_RATIO * 100:.0f}%〜+{DURATION_TOLERANCE_LONGER_RATIO * 100:.0f}%"
                f"、または{DURATION_TOLERANCE_MIN_SEC:.0f}秒)")
        if not ok:
            return discard(
                f"録画の尺が理論尺から{error_ratio * 100:+.1f}%ずれています", DIAG_DURATION_MISMATCH)

    # スコア監視のあるタイトルで、期待スコアが0より大きいのに最後まで0だった録画は、メニュー操作の
    # 取りこぼし等でリプレイが始まらなかったとみなして破棄する(Issue #324)。
    scores = read_verified_scores(config.log_path, config.game_id)
    if is_score_zero(config, expected_score, scores=scores):
        return discard(
            f"期待スコア({expected_score}) > 0 ですが、録画中のゲーム内スコアが最後まで0のままでした"
            "(リプレイが開始されなかった可能性があります)", "score_zero")

    timed_out = result["classification"] == "timeout"
    if timed_out:
        log("WARNING: リプレイ終了を検知できないままタイムアウトで打ち切られました。"
            "リプレイ終盤が録画されていない可能性があります")
    log("正常な録画を確認しました")
    desync_detected = check_replay_desync(config, expected_score, log=log, scores=scores)
    write_desync_result(desync_result_path, desync_detected)
    write_timeout_result(timeout_result_path, timed_out)
    write_cut_result(cut_result_path, result.get("cut"))
    return True
