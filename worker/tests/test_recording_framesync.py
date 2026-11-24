"""フレーム同期キャプチャの録画経路(`recording/framesync.py`、Issue #389)。

ffmpeg・MOD・Wineはすべてモックにする。実機での検証は
`docs/reports/2026-11-22-worker-frame-sync-full-length-verification.md`。
"""
import json
import os
import stat

import numpy as np
import pytest

import pulse
from recording import framesync, pipeline
from recording.modlog import find_frame_sync_replay_start_frame
from recording_helpers import make_config


# ---------------------------------------------------------------------------
# 三者照合・理論尺・進捗の算出(純粋関数)
# ---------------------------------------------------------------------------
def test_check_frame_counts_accepts_matching_triple():
    counts = framesync.check_frame_counts(3600, 3600, 3600 * framesync.AUDIO_BYTES_PER_VIDEO_FRAME)
    assert counts.ok
    assert counts.audio_frames == 3600
    assert counts.audio_remainder_bytes == 0


@pytest.mark.parametrize("written,video,audio_bytes", [
    (3601, 3600, 3600 * 2940),   # MODが1枚多く書いた(ffmpegが取りこぼした)
    (3600, 3599, 3600 * 2940),   # 動画が1枚足りない
    (3600, 3600, 3599 * 2940),   # 音声が1フレームぶん足りない
    (3600, 3600, 3600 * 2940 + 1),  # PCMに端数がある(書き出しが途中で切れた)
])
def test_check_frame_counts_rejects_any_mismatch(written, video, audio_bytes):
    assert not framesync.check_frame_counts(written, video, audio_bytes).ok


def test_check_frame_counts_rejects_missing_values():
    # MODが取り込みの停止を報告しなかった(frames_written=None)/動画が読めなかった
    assert not framesync.check_frame_counts(None, 3600, 3600 * 2940).ok
    assert not framesync.check_frame_counts(3600, None, 3600 * 2940).ok


def test_audio_bytes_per_video_frame_is_735_stereo_s16_samples():
    assert framesync.AUDIO_BYTES_PER_VIDEO_FRAME == 735 * 2 * 2


def test_check_expected_duration_within_tolerance():
    ok, error = framesync.check_expected_duration(612.0, 600.0)
    assert ok and error == pytest.approx(0.02)


def test_check_expected_duration_rejects_a_recording_more_than_ten_percent_longer():
    assert not framesync.check_expected_duration(600 * 1.11, 600.0)[0]
    assert framesync.check_expected_duration(600 * 1.09, 600.0)[0]


def test_check_expected_duration_rejects_a_recording_more_than_thirty_percent_shorter():
    assert not framesync.check_expected_duration(600 * 0.69, 600.0)[0]
    assert framesync.check_expected_duration(600 * 0.71, 600.0)[0]
    # リプレイが再生されなかった録画(終了検知が再生直後に成立する)は弾く
    assert not framesync.check_expected_duration(2.0, 600.0)[0]


def test_check_expected_duration_accepts_what_was_measured_on_valid_recordings():
    """実測(本番のリプレイを全編録画して、スコアの一致まで確かめたもの)はすべて許容内。"""
    for play_sec, expected_sec in [
        (735.1, 738.0), (765.0, 765.0), (855.0, 890.0), (805.1, 847.0),  # th20・th15・th07・th08
        (741.0, 862.0),  # th06のExtra: パーサーの理論尺が長すぎる(-14.2%、実時間の経路も753.8秒)
    ]:
        assert framesync.check_expected_duration(play_sec, expected_sec)[0], (play_sec, expected_sec)


def test_check_expected_duration_accepts_the_systematic_th06_th07_offset():
    # replay-parserのframeCountの系統差(-5.65%、TR reports/111・112)は許容内
    ok, error = framesync.check_expected_duration(600.0 * (1 - 0.0565), 600.0)
    assert ok and error == pytest.approx(-0.0565)


def test_check_expected_duration_has_an_absolute_floor_for_short_replays():
    # 20秒のリプレイの+10%は2秒だが、絶対値の下限(3秒)まで許す
    assert framesync.check_expected_duration(22.9, 20.0)[0]
    assert not framesync.check_expected_duration(23.5, 20.0)[0]


def test_check_expected_duration_is_skipped_without_inputs():
    assert framesync.check_expected_duration(None, 600.0) == (True, None)
    assert framesync.check_expected_duration(600.0, None) == (True, None)
    assert framesync.check_expected_duration(600.0, 0) == (True, None)


def test_play_duration_is_measured_from_the_replay_start_frame():
    # リプレイ再生確定が動画の600フレーム目=10秒、終了検知が70秒の位置なら再生区間は60秒
    assert framesync.play_duration_sec(70.0, 600) == pytest.approx(60.0)
    assert framesync.play_duration_sec(None, 600) is None
    assert framesync.play_duration_sec(70.0, None) is None


def test_progress_is_the_recorded_play_seconds_based_on_frames_not_wall_clock():
    start = framesync.start_poll_number(600, fallback=0)  # 600フレーム=10秒=サブ出力80枚
    assert start == 80
    # 動画の70秒時点(560枚)なら、リプレイ再生開始から60秒
    assert framesync.progress_seconds(560, start) == pytest.approx(60.0)
    # メニュー区間は進捗に含めない
    assert framesync.progress_seconds(40, start) == 0.0


def test_start_poll_number_falls_back_when_the_log_has_no_unthrottled_line():
    assert framesync.start_poll_number(None, fallback=123) == 123


# ---------------------------------------------------------------------------
# FIFO・ffmpegコマンド
# ---------------------------------------------------------------------------
def test_open_pipe_creates_a_readwrite_fifo_with_a_larger_buffer(tmp_path):
    config = make_config(instance_dir=str(tmp_path / "instance"))
    # 前回の残骸があっても作り直す
    os.makedirs(config.instance_dir)
    open(framesync.pipe_path(config), "w").close()
    open(framesync.stop_path(config), "w").close()

    fd = framesync._open_pipe(config, log=lambda m: None)
    try:
        assert stat.S_ISFIFO(os.stat(framesync.pipe_path(config)).st_mode)
        assert not os.path.exists(framesync.stop_path(config))
        os.write(fd, b"frame")  # O_RDWRなので、読み手が居なくても書き込みがブロックしない
        assert os.read(fd, 5) == b"frame"
        assert fcntl_pipe_size(fd) >= 1 << 20
    finally:
        os.close(fd)


def test_open_pipe_falls_back_to_smaller_buffers_when_the_user_pipe_limit_is_hit(tmp_path, monkeypatch):
    """コンテナ(CAP_SYS_RESOURCE無し)では、pipe-user-pages-softを超えるとF_SETPIPE_SZがEPERMになる。"""
    import fcntl
    real = fcntl.fcntl
    requested = []

    def fcntl_stub(fd, cmd, arg=0):
        if cmd == framesync._F_SETPIPE_SZ:
            requested.append(arg)
            if arg > (1 << 18):
                raise PermissionError(1, "Operation not permitted")
        return real(fd, cmd, arg)

    monkeypatch.setattr(framesync.fcntl, "fcntl", fcntl_stub)
    messages = []
    config = make_config(instance_dir=str(tmp_path / "instance"))
    fd = framesync._open_pipe(config, log=messages.append)
    os.close(fd)
    assert requested[:3] == [1 << 20, 1 << 19, 1 << 18]
    assert sum("広げられませんでした" in m for m in messages) == 2
    assert "バッファ262144バイト" in messages[-1]


def test_open_pipe_keeps_the_default_size_when_every_size_is_refused(tmp_path, monkeypatch):
    import fcntl
    real = fcntl.fcntl

    def fcntl_stub(fd, cmd, arg=0):
        if cmd == framesync._F_SETPIPE_SZ:
            raise PermissionError(1, "Operation not permitted")
        return real(fd, cmd, arg)

    monkeypatch.setattr(framesync.fcntl, "fcntl", fcntl_stub)
    messages = []
    config = make_config(instance_dir=str(tmp_path / "instance"))
    os.close(framesync._open_pipe(config, log=messages.append))
    assert any("既定の大きさのまま" in m for m in messages)
    assert "バッファ65536バイト" in messages[-1]


def fcntl_pipe_size(fd):
    import fcntl
    return fcntl.fcntl(fd, 1032)  # F_GETPIPE_SZ


def test_build_video_cmd_reads_rawvideo_from_the_fifo_with_the_logged_format(tmp_path):
    config = make_config(instance_dir=str(tmp_path))
    paths = framesync._intermediate_paths(str(tmp_path / "video.mp4"))
    cmd = framesync.build_video_cmd(config, 1280, 960, "rgb0", paths)
    joined = " ".join(cmd)
    assert "-nostdin" in cmd
    assert cmd[cmd.index("-f") + 1] == "rawvideo"
    assert cmd[cmd.index("-pix_fmt") + 1] == "rgb0"
    assert cmd[cmd.index("-video_size") + 1] == "1280x960"
    assert cmd[cmd.index("-framerate") + 1] == "60"
    assert cmd[cmd.index("-i") + 1] == framesync.pipe_path(config)
    # 本出力は今の本番の生動画と同じ設定(libx264 veryfast crf18)
    assert "-c:v libx264 -preset veryfast -crf 18 -pix_fmt yuv420p" in joined
    assert cmd[-1] == paths["preview"]
    # 終了検知用のサブ出力: 160x120 gray・動画の1秒につき8枚・即時flush
    assert "fps=8,scale=160:120,format=gray" in joined
    assert paths["poll"] in cmd and "-flush_packets" in cmd
    assert paths["video"] in cmd


def test_build_mux_cmd_copies_video_and_encodes_the_virtual_audio():
    cmd = framesync.build_mux_cmd("v.mp4", "a.pcm", "out.mp4")
    assert "-c:v" in cmd and cmd[cmd.index("-c:v") + 1] == "copy"
    assert cmd[cmd.index("-ar") + 1] == "44100" and cmd[cmd.index("-ac") + 1] == "2"
    assert cmd[cmd.index("-b:a") + 1] == "192k"
    # 同じフレーム数なので位置合わせ(-itsoffset)は要らない
    assert "-itsoffset" not in cmd


# ---------------------------------------------------------------------------
# 終了検知(動画の時間で判定する)
# ---------------------------------------------------------------------------
class _FakeProc:
    def __init__(self, returncode=None):
        self._returncode = returncode
        self.returncode = returncode

    def poll(self):
        return self._returncode


class _Clock:
    """`sleep()`が時計を進める偽の実時間。"""

    def __init__(self):
        self.now = 1000.0

    def time(self):
        return self.now

    def sleep(self, sec):
        self.now += sec


def _poll_file(tmp_path, frames):
    """サブ出力(160x120 gray)のファイルを作る。framesは1枚ずつの画素値(スカラー)のリスト。"""
    path = tmp_path / "video.pollstream.raw"
    with open(path, "wb") as f:
        for value in frames:
            f.write(bytes([value]) * (framesync.POLL_FRAME_W * framesync.POLL_FRAME_H))
    return str(path)


def _detection(template=None):
    still_mask = np.ones((framesync.POLL_FRAME_H, framesync.POLL_FRAME_W), dtype=bool)
    return pipeline._EndDetection(
        template=template, template_mask=still_mask, template_mad_threshold=15.0, still_mask=still_mask,
    )


def _monitor(tmp_path, frames, config=None, detection=None, start_number=0, clock=None, proc=None, **kw):
    clock = clock or _Clock()
    config = config or make_config(instance_dir=str(tmp_path))
    paths = {"poll": _poll_file(tmp_path, frames), "preview": str(tmp_path / "preview.jpg")}
    messages = []
    result = framesync._monitor_until_end(
        config, detection or _detection(), proc or _FakeProc(), paths, start_number,
        progress_dir=None, expected_duration_seconds=None, log=messages.append,
        clock=clock.time, sleep=clock.sleep, **kw,
    )
    return result, messages


def test_monitor_detects_a_still_screen_in_video_time_and_reports_where_it_began(tmp_path):
    # 画素値が毎サンプル変わる区間のあと、完全に静止する。サンプルは動画の2秒(=16枚)間隔、猶予は15秒。
    changing = []
    for i in range(400):
        changing.append(i % 200)  # 1枚ごとに値が変わる
    still = [77] * 400
    result, _ = _monitor(tmp_path, changing + still)
    assert result.detected and result.detected_by == "still"
    # 静止は動画の50秒(400枚)から。連続検知の起点は「静止の直前のサンプル」で、動画の秒で返る
    assert 45 <= result.content_end_sec <= 51


def test_monitor_grace_period_is_counted_in_video_seconds(tmp_path):
    # 完全に静止した画面でも、再生開始から動画の15秒(=120枚)が過ぎるまでサンプルを取らない。最初の
    # サンプル(15秒)は比較相手が無いので、判定ログは次のサンプル(17秒)から出る。
    result, messages = _monitor(tmp_path, [10] * 2000)
    assert result.detected_by == "still"
    first_poll = next(m for m in messages if m.startswith("poll: video="))
    assert "video=17.0s" in first_poll and "still=1" in first_poll
    # 検知の確定は静止の8サンプル(動画の16秒)連続のあと。起点は最初のサンプル(15秒)
    assert result.content_end_sec == pytest.approx(15.0)


def test_monitor_template_match_ends_after_two_consecutive_matches(tmp_path):
    template = np.full((framesync.POLL_FRAME_H, framesync.POLL_FRAME_W), 200, dtype=np.float32)
    frames = [(i * 3) % 120 for i in range(600)] + [200] * 400
    result, _ = _monitor(tmp_path, frames, detection=_detection(template))
    assert result.detected and result.detected_by == "template"
    # テンプレートに最初に一致したサンプル(動画の75秒 = 600枚)の位置
    assert result.content_end_sec == pytest.approx(75.0, abs=2.1)


def test_monitor_stops_when_the_poll_stream_stalls_in_real_time(tmp_path):
    # 5枚(動画の0.6秒)しか来ない。猶予の位置に届かず、実時間で120秒増えなければ打ち切る
    result, messages = _monitor(tmp_path, [1, 2, 3, 4, 5])
    assert result.stalled and not result.detected
    assert any("120秒間フレームが届いていません" in m for m in messages)


def test_monitor_timeout_is_a_fixed_120_minutes_not_scaled_by_time_scale():
    assert framesync.RECORDING_TIMEOUT_SEC == 120 * 60
    # 実時間の経路の`min(TIMEOUT_SEC * time_scale, MAX_WALL_CLOCK_TIMEOUT_SEC)`はtime_scale=1で60分になる
    assert pipeline.TIMEOUT_SEC == 60 * 60


def test_monitor_gives_up_at_the_recording_timeout(tmp_path):
    clock = _Clock()
    result, messages = _monitor(
        tmp_path, [i % 250 for i in range(40)], clock=clock, timeout_sec=300, stall_timeout_sec=10_000,
    )
    assert result.timed_out and not result.detected
    assert any("TIMEOUT" in m for m in messages)


def test_monitor_gives_up_when_replay_video_exceeds_max_length(tmp_path):
    assert framesync.MAX_REPLAY_VIDEO_SEC == 2 * 60 * 60
    result, messages = _monitor(
        tmp_path, [i % 250 for i in range(200)], max_video_sec=10, stall_timeout_sec=10_000,
    )
    assert result.timed_out and not result.detected
    assert any("録画尺" in m for m in messages)


def test_monitor_reports_ffmpeg_exit(tmp_path):
    result, _ = _monitor(tmp_path, [1] * 10, proc=_FakeProc(returncode=1))
    assert result.ffmpeg_exited and not result.detected


def test_monitor_detects_wine_crash_from_new_wine_log_output(tmp_path):
    config = make_config(instance_dir=str(tmp_path))
    wine_log = tmp_path / "wine.log"
    wine_log.write_text("injector started\n")
    clock = _Clock()
    orig_sleep = clock.sleep

    def sleep(sec):
        if not wine_log.read_text().endswith("crash\n"):
            with open(wine_log, "a") as f:
                f.write("err:seh:NtRaiseException Unhandled exception code c0000005 crash\n")
        orig_sleep(sec)

    clock.sleep = sleep
    paths = {"poll": _poll_file(tmp_path, [1, 2]), "preview": str(tmp_path / "preview.jpg")}
    result = framesync._monitor_until_end(
        config, _detection(), _FakeProc(), paths, 0, progress_dir=None,
        expected_duration_seconds=None, log=lambda m: None, clock=clock.time, sleep=clock.sleep,
    )
    assert result.crashed and not result.detected


def test_monitor_freeze_is_counted_in_video_seconds_for_template_titles(tmp_path):
    # テンプレートに一致せず、画面が動画の300秒(150サンプル)静止したままならfrozen
    template = np.full((framesync.POLL_FRAME_H, framesync.POLL_FRAME_W), 250, dtype=np.float32)
    result, _ = _monitor(tmp_path, [10] * 3000, detection=_detection(template))
    assert result.frozen and not result.detected


def test_monitor_writes_progress_from_frames_not_wall_clock(tmp_path, monkeypatch):
    from PIL import Image
    Image.new("RGB", (480, 360), (10, 20, 30)).save(tmp_path / "preview.jpg")
    saved = []
    monkeypatch.setattr(framesync, "save_progress_snapshot",
                        lambda progress_dir, frame, elapsed, expected: saved.append((elapsed, expected)))
    config = make_config(instance_dir=str(tmp_path))
    paths = {"poll": _poll_file(tmp_path, [i % 250 for i in range(800)] + [5] * 800),
             "preview": str(tmp_path / "preview.jpg")}
    clock = _Clock()
    framesync._monitor_until_end(
        config, _detection(), _FakeProc(), paths, 80, progress_dir=str(tmp_path / "progress"),
        expected_duration_seconds=600, log=lambda m: None, clock=clock.time, sleep=clock.sleep,
    )
    # 最初の書き出しは、その時点で届いているサブ出力の枚数から(再生開始の80枚目を引いて)求める
    assert saved
    elapsed, expected = saved[0]
    assert expected == 600
    assert elapsed == pytest.approx((1600 - 80) / 8)


# ---------------------------------------------------------------------------
# 1回の試行(ハンドシェイク・三者照合・後片付け)
# ---------------------------------------------------------------------------
MOD_LOG = [
    "[00:00:01.000] WaitForStableWindow: stable after 100 ms total",
    "[00:00:02.000] FrameSync: capture start width=640 height=480 d3dfmt=21 pix_fmt=bgr0 multisample=0",
    "[00:00:03.000] Step 1: Enter",
    "[00:00:04.000] Step 5: Enter (start replay)",
    "[00:00:04.700] FrameSync: unthrottled=1 at frame=600",
    "[00:00:04.701] === th08_replay_autoplay: sequence complete ===",
]


@pytest.fixture
def fake_environment(monkeypatch, tmp_path):
    """MOD・ffmpeg・Wineを偽物にした試行の舞台。"""
    config = make_config(instance_dir=str(tmp_path / "instance"))
    os.makedirs(config.instance_dir)
    output_path = str(tmp_path / "out" / "video.mp4")
    os.makedirs(os.path.dirname(output_path))
    state = {"popen": [], "killed": 0, "video_frames": 3600, "write_audio": True,
             "stopped_line": "[00:10:00.000] FrameSync: capture stopped frames_written=3600 present_count=3601 "
                             "frames_with_live_threads=0 throttle_while_threads=0",
             "monitor": framesync._Monitor(detected=True, detected_by="template", content_end_sec=70.0)}

    def launch(config_, env, replay_path, log):
        state["env"] = env
        with open(config_.log_path, "w") as f:
            f.write("\n".join(MOD_LOG + ([state["stopped_line"]] if state["stopped_line"] else [])) + "\n")
        return "1234"

    class Popen:
        returncode = 0

        def __init__(self, cmd, **kw):
            state["popen"].append(cmd)
            paths = framesync._intermediate_paths(output_path)
            with open(paths["video"], "wb") as f:
                f.write(b"mp4")
            if state["write_audio"]:
                with open(paths["audio"], "wb") as f:
                    f.write(b"\0" * (state["video_frames"] * framesync.AUDIO_BYTES_PER_VIDEO_FRAME))

        _done = False

        def poll(self):
            # ffmpegはEOFを受けて終了するまで動いている
            return 0 if self._done else None

        def wait(self, timeout=None):
            self._done = True
            return 0

        def send_signal(self, sig):
            self._done = True

    def mux(paths, output, env, log):
        with open(output, "wb") as f:
            f.write(b"muxed")
        return True

    monkeypatch.setattr(framesync, "_launch_game", launch)
    monkeypatch.setattr(framesync.subprocess, "Popen", Popen)
    monkeypatch.setattr(framesync, "_monitor_until_end", lambda *a, **k: state["monitor"])
    monkeypatch.setattr(framesync, "_count_video_frames", lambda path, env: state["video_frames"])
    monkeypatch.setattr(framesync, "_mux", mux)
    monkeypatch.setattr(framesync, "kill_wine_and_wait",
                        lambda *a, **k: state.__setitem__("killed", state["killed"] + 1))
    monkeypatch.setattr(framesync, "load_end_template", lambda path: None)
    monkeypatch.setattr(framesync, "wait_for_log_marker",
                        lambda path, marker, **k: 1.0 if marker in open(path).read() else None)
    state.update(config=config, output=output_path)
    return state


def _attempt(state, **kw):
    return framesync.attempt_recording_frame_sync(
        state["config"], "/replay.rpy", state["output"], None, kw.get("expected"), log=lambda m: None)


def test_attempt_hands_the_fifo_stop_file_and_audio_paths_to_the_mod(fake_environment):
    _attempt(fake_environment)
    env = fake_environment["env"]
    config = fake_environment["config"]
    assert env["FRAME_SYNC_PIPE"].startswith("Z:") and env["FRAME_SYNC_PIPE"].endswith("framesync.fifo")
    assert env["FRAME_SYNC_STOP"].endswith("framesync.stop")
    assert env["FRAME_SYNC_AUDIO"].endswith(".audio.pcm")
    # 倍速・低速録画・同期マーカーの変数は渡さない
    for name in ("FPS_LIMIT_TARGET_HZ", "SPEED_HACK_MULTIPLIER", "SYNC_MARKER_TRIGGER"):
        assert name not in env
    # 後片付け: FIFOは残さず、wineを必ず片付ける
    assert not os.path.exists(framesync.pipe_path(config))
    assert fake_environment["killed"] == 1


def test_attempt_starts_ffmpeg_with_the_format_the_mod_logged(fake_environment):
    _attempt(fake_environment)
    (cmd,) = fake_environment["popen"]
    assert cmd[cmd.index("-pix_fmt") + 1] == "bgr0"
    assert cmd[cmd.index("-video_size") + 1] == "640x480"


def test_attempt_succeeds_when_frame_counts_agree(fake_environment):
    result = _attempt(fake_environment)
    assert result["output_exists"] and result["classification"] == "good"
    assert result["counts"].ok
    # 再生区間 = 終了検知(70秒) - リプレイ再生確定のフレーム(Step 5から0.7秒前=600-42=558フレーム=9.3秒)
    assert result["play_sec"] == pytest.approx(70.0 - 558 / 60)
    assert result["time_scale"] == 1.0


def test_attempt_is_setup_error_when_the_mod_wrote_a_different_number_of_frames(fake_environment):
    fake_environment["video_frames"] = 3599  # ffmpegが1枚取りこぼした
    result = _attempt(fake_environment)
    assert result["classification"] == "setup_error"
    assert not result["counts"].ok


def test_attempt_is_setup_error_when_the_mod_never_reports_the_stop(fake_environment):
    fake_environment["stopped_line"] = None
    result = _attempt(fake_environment)
    assert result["classification"] == "setup_error"


def test_attempt_is_setup_error_when_the_audio_is_missing(fake_environment):
    fake_environment["write_audio"] = False
    result = _attempt(fake_environment)
    assert result["classification"] == "setup_error"
    assert not result["output_exists"]


def test_attempt_classifies_a_wine_crash(fake_environment):
    fake_environment["monitor"] = framesync._Monitor(crashed=True)
    assert _attempt(fake_environment)["classification"] == "crashed"


def test_attempt_classifies_timeout_and_stall_as_timeout(fake_environment):
    fake_environment["monitor"] = framesync._Monitor(timed_out=True)
    assert _attempt(fake_environment)["classification"] == "timeout"
    fake_environment["monitor"] = framesync._Monitor(stalled=True)
    assert _attempt(fake_environment)["classification"] == "timeout"


def test_attempt_fails_when_the_mod_does_not_support_frame_sync(monkeypatch, fake_environment):
    monkeypatch.setattr(framesync, "wait_for_log_marker", lambda *a, **k: None)
    monkeypatch.setattr(framesync, "_log_failure_diagnostics", lambda *a: None)
    result = _attempt(fake_environment)
    assert not result["output_exists"] and result["classification"] == "setup_error"
    assert fake_environment["popen"] == []  # ffmpegは起動しない
    assert fake_environment["killed"] == 1


def test_attempt_attaches_thprac_after_the_window_appears(monkeypatch, fake_environment):
    calls = []
    fake_environment["config"] = make_config(
        instance_dir=fake_environment["config"].instance_dir, thprac_exe="thprac.exe")
    monkeypatch.setattr(framesync, "find_window", lambda *a: calls.append("window") or (0, 0, 1, 1, "1"))
    monkeypatch.setattr(framesync, "attach_thprac", lambda *a, **k: calls.append("attach"))
    _attempt(fake_environment)
    assert calls == ["window", "attach"]


def test_attempt_cleans_up_even_if_stop_capture_raises_after_closing_pipe(monkeypatch, fake_environment):
    """_stop_capture() が pipe_fd を閉じた後に例外を出しても、finally が二重クローズで落ちず後片付けを完遂する。"""
    def stop_that_closes_pipe_and_fails(config, pipe_fd, video_proc, seen_lines, log):
        os.close(pipe_fd)
        raise RuntimeError("wait failed")

    monkeypatch.setattr(framesync, "_stop_capture", stop_that_closes_pipe_and_fails)
    with pytest.raises(RuntimeError, match="wait failed"):
        _attempt(fake_environment)
    assert fake_environment["killed"] == 1
    assert not os.path.exists(framesync.pipe_path(fake_environment["config"]))


# ---------------------------------------------------------------------------
# 合否判定: ワーカーの中ではリトライしない
# ---------------------------------------------------------------------------
@pytest.fixture
def verdict(monkeypatch, tmp_path):
    state = {"calls": 0, "result": None}

    def attempt(*a, **k):
        state["calls"] += 1
        return state["result"]

    good_counts = framesync.check_frame_counts(3600, 3600, 3600 * 2940)
    state["result"] = {
        "output_exists": True, "classification": "good", "total_record_sec": 60.0, "cut": {
            "startSec": 5.0, "endSec": 58.0}, "time_scale": 1.0, "counts": good_counts, "play_sec": 590.0,
        "detected": True, "last_preview": None,
    }
    state["good_counts"] = good_counts
    state["snapshots"] = []
    monkeypatch.setattr(framesync, "attempt_recording_frame_sync", attempt)
    monkeypatch.setattr(framesync, "save_diagnostics_snapshot",
                        lambda d, frame, attempt_no, classification: state["snapshots"].append(classification))
    monkeypatch.setattr(framesync, "read_verified_scores", lambda *a: [1, 2, 3])
    monkeypatch.setattr(framesync, "check_replay_desync", lambda *a, **k: False)
    state["tmp"] = tmp_path
    return state


def _verdict(state, **kw):
    config = make_config(instance_dir=str(state["tmp"]))
    return framesync.record_frame_sync(
        config, "/replay.rpy", "/out.mp4", expected_duration_seconds=kw.pop("expected", 600.0),
        diagnostics_dir="/diag", log=lambda m: None, **kw)


def test_success_writes_desync_timeout_and_cut_results_once(verdict):
    paths = {name: str(verdict["tmp"] / f"{name}.json") for name in ("desync", "timeout", "cut")}
    assert _verdict(verdict, desync_result_path=paths["desync"], timeout_result_path=paths["timeout"],
                    cut_result_path=paths["cut"], expected_score=3) is True
    assert verdict["calls"] == 1
    assert json.load(open(paths["desync"])) == {"desyncDetected": False}
    assert json.load(open(paths["timeout"])) == {"timedOut": False}
    assert json.load(open(paths["cut"])) == {"startSec": 5.0, "endSec": 58.0}


def test_frame_count_mismatch_fails_without_retry(verdict):
    verdict["result"].update(
        classification="setup_error", counts=framesync.check_frame_counts(3600, 3599, 3600 * 2940))
    assert _verdict(verdict) is False
    assert verdict["calls"] == 1
    assert verdict["snapshots"] == [framesync.DIAG_FRAME_MISMATCH]


def test_shorter_duration_mismatch_is_delivered_with_a_desync_warning(verdict):
    # 途中までは再生できたリプレイずれによる早期終了は、失敗にせず警告として配信する
    verdict["result"]["play_sec"] = 400.0  # 理論尺600秒から-33%(短い側の許容30%を超える)
    path = str(verdict["tmp"] / "desync.json")
    assert _verdict(verdict, desync_result_path=path) is True
    assert verdict["snapshots"] == []
    assert json.load(open(path)) == {"desyncDetected": True}


def test_longer_duration_mismatch_is_delivered_without_a_desync_flag(verdict):
    verdict["result"]["play_sec"] = 600.0 * 1.2
    path = str(verdict["tmp"] / "desync.json")
    assert _verdict(verdict, desync_result_path=path) is True
    assert json.load(open(path)) == {"desyncDetected": False}


def test_almost_nothing_played_fails_without_retry(verdict):
    verdict["result"]["play_sec"] = 1.0
    assert _verdict(verdict) is False
    assert verdict["calls"] == 1
    assert verdict["snapshots"] == [framesync.DIAG_DURATION_MISMATCH]


def test_duration_within_tolerance_passes(verdict):
    verdict["result"]["play_sec"] = 600.0 * (1 - 0.0565)
    assert _verdict(verdict) is True


def test_duration_is_not_checked_without_an_expected_duration(verdict):
    verdict["result"]["play_sec"] = 5.0
    assert _verdict(verdict, expected=None) is True


def test_duration_is_not_checked_when_the_end_was_not_detected(verdict):
    # 終了を検知できないままタイムアウトした録画は尺が短くて当然。成功扱いでtimedOutを記録する(従来と同じ)
    verdict["result"].update(classification="timeout", detected=False, play_sec=None)
    path = str(verdict["tmp"] / "timeout.json")
    assert _verdict(verdict, timeout_result_path=path) is True
    assert json.load(open(path)) == {"timedOut": True}


def test_wine_crash_fails_without_retry(verdict):
    verdict["result"].update(classification="crashed")
    assert _verdict(verdict) is False
    assert verdict["calls"] == 1
    assert verdict["snapshots"] == ["crashed"]


def test_missing_output_fails(verdict):
    verdict["result"].update(output_exists=False, classification="setup_error", counts=None)
    assert _verdict(verdict) is False
    assert verdict["calls"] == 1


def test_zero_score_fails_when_a_positive_score_was_expected(verdict, monkeypatch):
    monkeypatch.setattr(framesync, "read_verified_scores", lambda *a: [0, 0])
    monkeypatch.setattr(framesync, "is_score_zero", lambda *a, **k: True)
    assert _verdict(verdict, expected_score=1000) is False
    assert verdict["snapshots"] == ["score_zero"]


def test_does_not_measure_duplicate_frame_rate(verdict, monkeypatch):
    # 重複フレーム率による合否判定はフレーム同期では使わない
    monkeypatch.setattr(pipeline, "measure_duplicate_rate",
                        lambda *a, **k: pytest.fail("重複フレーム率を計測してはならない"))
    assert _verdict(verdict) is True


def test_unexpected_exception_is_a_failure_and_still_cleans_up(monkeypatch, tmp_path):
    killed = []
    monkeypatch.setattr(framesync, "attempt_recording_frame_sync",
                        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom")))
    monkeypatch.setattr(framesync, "kill_wine_and_wait", lambda *a, **k: killed.append(1))
    config = make_config(instance_dir=str(tmp_path))
    assert framesync.record_frame_sync(config, "/r.rpy", "/o.mp4", log=lambda m: None) is False
    assert killed == [1]


# ---------------------------------------------------------------------------
# CAPTURE_MODEによる経路の分岐
# ---------------------------------------------------------------------------
def test_record_with_retry_takes_the_frame_sync_path_only_when_capture_mode_is_set(monkeypatch):
    events = []
    monkeypatch.setattr(pulse, "create_null_sink", lambda *a, **k: events.append("sink") or "1")
    monkeypatch.setattr(pulse, "unload_module", lambda *a, **k: True)
    monkeypatch.setattr(framesync, "record_frame_sync", lambda *a, **k: events.append("frame_sync") or True)
    monkeypatch.setattr(pipeline, "_record_with_retry", lambda *a, **k: events.append("realtime") or True)
    config = make_config()

    monkeypatch.delenv("CAPTURE_MODE", raising=False)
    assert pipeline.record_with_retry(config, "/r.rpy", "/o.mp4", log=lambda m: None)
    assert "realtime" in events and "frame_sync" not in events

    events.clear()
    monkeypatch.setenv("CAPTURE_MODE", "frame_sync")
    assert pipeline.record_with_retry(config, "/r.rpy", "/o.mp4", log=lambda m: None)
    assert "frame_sync" in events and "realtime" not in events
    # ジョブ専用sinkは作る(Wineの出力先)
    assert "sink" in events


def test_other_capture_mode_values_keep_the_realtime_path(monkeypatch):
    monkeypatch.setenv("CAPTURE_MODE", "realtime")
    monkeypatch.setattr(pulse, "create_null_sink", lambda *a, **k: "1")
    monkeypatch.setattr(pulse, "unload_module", lambda *a, **k: True)
    called = []
    monkeypatch.setattr(pipeline, "_record_with_retry", lambda *a, **k: called.append(1) or True)
    assert pipeline.record_with_retry(make_config(), "/r.rpy", "/o.mp4", log=lambda m: None)
    assert called == [1]


# ---------------------------------------------------------------------------
# MODログからの換算
# ---------------------------------------------------------------------------
def test_replay_start_frame_is_counted_back_from_the_unthrottled_line(tmp_path):
    log = tmp_path / "th08_autoplay.log"
    log.write_text("\n".join(MOD_LOG) + "\n")
    # Step 5(00:00:04.000)→上限解除(00:00:04.700)は0.7秒=42フレーム。上限解除は600フレーム目
    assert find_frame_sync_replay_start_frame(str(log)) == 600 - 42


def test_replay_start_frame_handles_midnight_rollover(tmp_path):
    log = tmp_path / "th08_autoplay.log"
    log.write_text("\n".join([
        "[23:59:59.500] Step 5: Enter",
        "[00:00:00.200] FrameSync: unthrottled=1 at frame=300",
        "[00:00:00.201] === th08_replay_autoplay: sequence complete ===",
    ]) + "\n")
    assert find_frame_sync_replay_start_frame(str(log)) == 300 - 42


def test_replay_start_frame_is_none_without_the_lines(tmp_path):
    log = tmp_path / "th08_autoplay.log"
    log.write_text("[00:00:01.000] Step 1: Enter\n")
    assert find_frame_sync_replay_start_frame(str(log)) is None
    assert find_frame_sync_replay_start_frame(str(tmp_path / "missing.log")) is None
