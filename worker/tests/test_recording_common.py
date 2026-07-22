import json

import numpy as np
import pytest
from PIL import Image

import recording_common as rc


def make_config(**overrides):
    kwargs = dict(
        game_id="th08",
        display=":98",
        wineprefix="/prefix",
        instance_dir="/instance",
        game_dir_src="/game",
        canonical_slot="th8_ud0000.rpy",
        injector_path="/mods/common/build/injector.exe",
        hook_dll_path="/mods/th08_replay_autoplay/build/th08_hook.dll",
    )
    kwargs.update(overrides)
    return rc.GameConfig(**kwargs)


def test_game_config_derives_exe_dll_and_log_path_from_game_id():
    config = make_config()

    assert config.game_exe == "th08.exe"
    assert config.hook_dll == "th08_hook.dll"
    assert config.log_path == "/instance/th08_autoplay.log"


def test_game_config_build_env_sets_wine_and_locale_vars():
    config = make_config()

    env = config.build_env()

    assert env["WINEPREFIX"] == "/prefix"
    assert env["DISPLAY"] == ":98"
    assert env["LANG"] == "ja_JP.UTF-8"
    assert env["LC_ALL"] == "ja_JP.UTF-8"


def test_mad_zero_for_identical_frames():
    a = np.zeros((4, 4), dtype=np.float32)
    assert rc.mad(a, a) == 0.0


def test_mad_computes_mean_absolute_difference():
    a = np.array([[0.0, 0.0], [0.0, 0.0]], dtype=np.float32)
    b = np.array([[2.0, 4.0], [0.0, 2.0]], dtype=np.float32)
    assert rc.mad(a, b) == pytest.approx(2.0)


def test_build_video_ffmpeg_cmd_captures_without_watermark():
    # ウォーターマークはmux_audio_video()側で合成するため、build_video_ffmpeg_cmd()は
    # 常にウォーターマークなしの生キャプチャコマンドを返す(-copytsとoverlayの
    # フレーム同期不具合を避けるため、reports/28参照)。
    config = make_config()
    cmd = rc.build_video_ffmpeg_cmd(config, 0, 0, 640, 480, "out.video.mp4")

    assert cmd[0] == "ffmpeg"
    assert "-filter_complex" not in cmd
    assert "-f" in cmd and "pulse" not in cmd  # 音声は別プロセス(reports/26)
    assert cmd[-1] == "out.video.mp4"
    assert "libx264" in cmd
    assert "640x480" in cmd
    assert "-copyts" in cmd  # A/V同期補正用の絶対start_time保持(reports/28)


def test_build_audio_ffmpeg_cmd_uses_pulse_source():
    config = make_config()
    cmd = rc.build_audio_ffmpeg_cmd(config, "out.audio.m4a")

    assert cmd[0] == "ffmpeg"
    assert "pulse" in cmd
    assert config.pulse_source in cmd
    assert cmd[-1] == "out.audio.m4a"
    assert "-copyts" in cmd  # A/V同期補正用の絶対start_time保持(reports/28)


def test_ffprobe_start_time_parses_ffprobe_output(monkeypatch):
    captured = {}

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        return type("Result", (), {"stdout": "1784765161.591758\n"})()

    monkeypatch.setattr(rc.subprocess, "run", fake_run)

    result = rc.ffprobe_start_time("video.mp4", {})

    assert result == pytest.approx(1784765161.591758)
    assert captured["cmd"][0] == "ffprobe"
    assert "video.mp4" in captured["cmd"]


def test_ffprobe_start_time_returns_none_on_unparsable_output(monkeypatch):
    monkeypatch.setattr(
        rc.subprocess, "run", lambda cmd, **kwargs: type("Result", (), {"stdout": "N/A\n"})()
    )

    assert rc.ffprobe_start_time("video.mp4", {}) is None


def test_mux_audio_video_delays_later_starting_audio(monkeypatch):
    monkeypatch.setattr(
        rc, "ffprobe_start_time",
        lambda path, env: 100.0 if "video" in path else 100.6,
    )
    captured = {}

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        return type("Result", (), {"returncode": 0, "stderr": b""})()

    monkeypatch.setattr(rc.subprocess, "run", fake_run)

    ok = rc.mux_audio_video("video.mp4", "audio.m4a", "out.mp4", {}, log=lambda msg: None)

    assert ok is True
    cmd = captured["cmd"]
    # 音声(audio.m4a)が0.6秒遅く開始したため、mux時にaudio側へ-itsoffsetを与えて補正する
    audio_idx = cmd.index("audio.m4a")
    assert cmd[audio_idx - 3] == "-itsoffset"
    assert float(cmd[audio_idx - 2]) == pytest.approx(0.6)
    video_idx = cmd.index("video.mp4")
    assert cmd[video_idx - 1] != "-itsoffset"


def test_mux_audio_video_delays_later_starting_video(monkeypatch):
    monkeypatch.setattr(
        rc, "ffprobe_start_time",
        lambda path, env: 100.6 if "video" in path else 100.0,
    )
    captured = {}

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        return type("Result", (), {"returncode": 0, "stderr": b""})()

    monkeypatch.setattr(rc.subprocess, "run", fake_run)

    rc.mux_audio_video("video.mp4", "audio.m4a", "out.mp4", {}, log=lambda msg: None)

    cmd = captured["cmd"]
    video_idx = cmd.index("video.mp4")
    assert cmd[video_idx - 3] == "-itsoffset"
    assert float(cmd[video_idx - 2]) == pytest.approx(0.6)


def test_mux_audio_video_skips_offset_when_start_time_unavailable(monkeypatch):
    monkeypatch.setattr(rc, "ffprobe_start_time", lambda path, env: None)
    captured = {}

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        return type("Result", (), {"returncode": 0, "stderr": b""})()

    monkeypatch.setattr(rc.subprocess, "run", fake_run)

    rc.mux_audio_video("video.mp4", "audio.m4a", "out.mp4", {}, log=lambda msg: None)

    assert "-itsoffset" not in captured["cmd"]


def test_mux_audio_video_uses_stream_copy(monkeypatch):
    # ウォーターマークはこの関数(録画直後のmux)では合成しない。x11grabの生ptsが
    # wallclockベース(実epoch秒)のまま`-copyts`でfiltergraphに渡ると、ほぼ0起点の
    # ウォーターマーク動画とoverlayのフレーム同期が噛み合わず不発になる不具合が
    # あったため、ウォーターマーク合成はupscale.py側(720p変換と同時)に移した。
    monkeypatch.setattr(rc, "ffprobe_start_time", lambda path, env: None)
    captured = {}

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        return type("Result", (), {"returncode": 0, "stderr": b""})()

    monkeypatch.setattr(rc.subprocess, "run", fake_run)

    rc.mux_audio_video("video.mp4", "audio.m4a", "out.mp4", {}, log=lambda msg: None)

    cmd = captured["cmd"]
    assert "-filter_complex" not in cmd
    assert "copy" in cmd


def test_save_progress_snapshot_writes_frame_and_state_atomically(tmp_path):
    color = Image.new("RGB", (640, 480), color=(10, 20, 30))

    rc.save_progress_snapshot(str(tmp_path), color, elapsed_seconds=12.3, expected_duration_seconds=60)

    assert (tmp_path / "frame.jpg").exists()
    assert not (tmp_path / "frame.jpg.tmp").exists()
    assert not (tmp_path / "state.json.tmp").exists()
    state = json.loads((tmp_path / "state.json").read_text())
    assert state == {"elapsedSeconds": 12.3, "expectedDurationSeconds": 60}


def test_wait_for_log_marker_finds_existing_marker(tmp_path):
    log_path = tmp_path / "th08_autoplay.log"
    log_path.write_text("some other line\nWaitForStableWindow: stable\n")

    result = rc.wait_for_log_marker(str(log_path), "WaitForStableWindow: stable", timeout=1, poll_interval=0.01)

    assert result is not None


def test_wait_for_log_marker_times_out_when_absent(tmp_path):
    log_path = tmp_path / "th08_autoplay.log"
    log_path.write_text("unrelated log line\n")

    result = rc.wait_for_log_marker(str(log_path), "WaitForStableWindow: stable", timeout=0.05, poll_interval=0.01)

    assert result is None


def test_wait_for_log_marker_times_out_when_log_file_missing(tmp_path):
    result = rc.wait_for_log_marker(
        str(tmp_path / "does-not-exist.log"), "WaitForStableWindow: stable", timeout=0.05, poll_interval=0.01
    )

    assert result is None


def test_scan_fps_runaway_returns_none_when_log_missing(tmp_path):
    assert rc.scan_fps_runaway(str(tmp_path / "missing.log")) is None


def test_scan_fps_runaway_ignores_values_at_or_below_threshold(tmp_path):
    log_path = tmp_path / "th08_autoplay.log"
    log_path.write_text(
        "FpsMonitor: 300 GetDeviceState calls in 5006 ms (59.9 Hz)\n"
        "FpsMonitor: 300 GetDeviceState calls in 5004 ms (60.0 Hz)\n"
    )

    assert rc.scan_fps_runaway(str(log_path)) is None


def test_scan_fps_runaway_ignores_single_spike_below_consecutive_requirement(tmp_path):
    # reports/23: 単発のノイズ(実測最大118Hz、直後に正常値へ復帰)は誤検知しない。
    log_path = tmp_path / "th08_autoplay.log"
    log_path.write_text(
        "FpsMonitor: 300 GetDeviceState calls in 5006 ms (59.9 Hz)\n"
        "FpsMonitor: 300 GetDeviceState calls in 2500 ms (118.1 Hz)\n"
        "FpsMonitor: 300 GetDeviceState calls in 5004 ms (60.1 Hz)\n"
    )

    assert rc.scan_fps_runaway(str(log_path)) is None


def test_scan_fps_runaway_detects_two_consecutive_spikes(tmp_path):
    # reports/22: fps暴走は実測479〜2700Hzがリプレイ全編にわたり持続する。
    log_path = tmp_path / "th08_autoplay.log"
    log_path.write_text(
        "FpsMonitor: 300 GetDeviceState calls in 5006 ms (59.9 Hz)\n"
        "FpsMonitor: 300 GetDeviceState calls in 100 ms (900.0 Hz)\n"
        "FpsMonitor: 300 GetDeviceState calls in 110 ms (850.0 Hz)\n"
    )

    assert rc.scan_fps_runaway(str(log_path)) == pytest.approx(900.0)


def test_record_with_retry_gives_up_after_max_attempts(monkeypatch):
    config = make_config()
    monkeypatch.setattr(rc, "attempt_recording", lambda *a, **k: {
        "output_exists": False, "classification": "setup_error", "fps_runaway_hz": None, "total_record_sec": 0.0,
    })

    success = rc.record_with_retry(config, "/replay.rpy", "/out.mp4", max_attempts=2, log=lambda msg: None)

    assert success is False


def test_record_with_retry_retries_on_fps_runaway_then_succeeds(monkeypatch):
    config = make_config()
    calls = []

    def fake_attempt(*args, **kwargs):
        calls.append(1)
        if len(calls) == 1:
            return {"output_exists": True, "classification": "fps_runaway", "fps_runaway_hz": 900.0, "total_record_sec": 5.0}
        return {"output_exists": True, "classification": "good", "fps_runaway_hz": None, "total_record_sec": 60.0}

    monkeypatch.setattr(rc, "attempt_recording", fake_attempt)
    monkeypatch.setattr(rc, "measure_duplicate_rate", lambda *a, **k: 1.0)

    success = rc.record_with_retry(config, "/replay.rpy", "/out.mp4", max_attempts=3, log=lambda msg: None)

    assert success is True
    assert len(calls) == 2


def test_record_with_retry_discards_output_above_max_duplicate_rate(monkeypatch):
    config = make_config()
    monkeypatch.setattr(rc, "attempt_recording", lambda *a, **k: {
        "output_exists": True, "classification": "good", "fps_runaway_hz": None, "total_record_sec": 60.0,
    })
    monkeypatch.setattr(rc, "measure_duplicate_rate", lambda *a, **k: 90.0)

    success = rc.record_with_retry(
        config, "/replay.rpy", "/out.mp4", max_attempts=1, max_duplicate_rate=30.0, log=lambda msg: None
    )

    assert success is False
