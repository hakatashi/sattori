import json

import numpy as np
import pytest
from PIL import Image

import record_th07 as rec


def test_mad_zero_for_identical_frames():
    a = np.zeros((4, 4), dtype=np.float32)
    assert rec.mad(a, a) == 0.0


def test_mad_computes_mean_absolute_difference():
    a = np.array([[0.0, 0.0], [0.0, 0.0]], dtype=np.float32)
    b = np.array([[2.0, 4.0], [0.0, 2.0]], dtype=np.float32)
    assert rec.mad(a, b) == pytest.approx(2.0)


def test_build_ffmpeg_cmd_without_watermark():
    cmd = rec.build_ffmpeg_cmd(0, 0, 640, 480, "out.mp4", None, 285)

    assert cmd[0] == "ffmpeg"
    assert "-filter_complex" not in cmd
    assert cmd[-1] == "out.mp4"
    assert "libx264" in cmd
    assert "640x480" in cmd


def test_build_ffmpeg_cmd_with_watermark_caps_width_at_half_frame_width():
    # ウォーターマーク幅は既定285pxでも、画面の半分より広くはしない
    # (狭いウィンドウで画面の大半を覆ってしまうのを防ぐ)。
    cmd = rec.build_ffmpeg_cmd(0, 0, 200, 480, "out.mp4", "watermark.webm", 285)

    assert "-filter_complex" in cmd
    filter_expr = cmd[cmd.index("-filter_complex") + 1]
    assert "scale=100:-1" in filter_expr  # min(285, 200 // 2) == 100
    assert "libvpx-vp9" in cmd  # VP9アルファはlibvpx経由デコーダでないと不透明扱いになる(reports/18)


def test_build_ffmpeg_cmd_with_watermark_keeps_requested_width_when_frame_is_wide():
    cmd = rec.build_ffmpeg_cmd(0, 0, 1920, 1080, "out.mp4", "watermark.webm", 285)

    filter_expr = cmd[cmd.index("-filter_complex") + 1]
    assert "scale=285:-1" in filter_expr


def test_save_progress_snapshot_writes_frame_and_state_atomically(tmp_path):
    color = Image.new("RGB", (640, 480), color=(10, 20, 30))

    rec.save_progress_snapshot(
        str(tmp_path), color, elapsed_seconds=12.3, expected_duration_seconds=60
    )

    assert (tmp_path / "frame.jpg").exists()
    assert not (tmp_path / "frame.jpg.tmp").exists()
    assert not (tmp_path / "state.json.tmp").exists()
    state = json.loads((tmp_path / "state.json").read_text())
    assert state == {"elapsedSeconds": 12.3, "expectedDurationSeconds": 60}


def test_wait_for_log_marker_finds_existing_marker(tmp_path, monkeypatch):
    log_path = tmp_path / "th07_autoplay.log"
    log_path.write_text("some other line\nWaitForStableWindow: stable\n")
    monkeypatch.setattr(rec, "LOG_PATH", str(log_path))

    result = rec.wait_for_log_marker("WaitForStableWindow: stable", timeout=1, poll_interval=0.01)

    assert result is not None


def test_wait_for_log_marker_times_out_when_absent(tmp_path, monkeypatch):
    log_path = tmp_path / "th07_autoplay.log"
    log_path.write_text("unrelated log line\n")
    monkeypatch.setattr(rec, "LOG_PATH", str(log_path))

    result = rec.wait_for_log_marker("WaitForStableWindow: stable", timeout=0.05, poll_interval=0.01)

    assert result is None


def test_wait_for_log_marker_times_out_when_log_file_missing(tmp_path, monkeypatch):
    monkeypatch.setattr(rec, "LOG_PATH", str(tmp_path / "does-not-exist.log"))

    result = rec.wait_for_log_marker("WaitForStableWindow: stable", timeout=0.05, poll_interval=0.01)

    assert result is None
