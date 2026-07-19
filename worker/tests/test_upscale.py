import json
from unittest.mock import MagicMock

import pytest

import upscale


def test_probe_resolution_parses_ffprobe_json(monkeypatch):
    fake_stdout = json.dumps({"streams": [{"width": 640, "height": 480}]})
    monkeypatch.setattr(
        upscale.subprocess, "run", MagicMock(return_value=MagicMock(stdout=fake_stdout))
    )

    assert upscale.probe_resolution("input.mp4") == (640, 480)


def test_probe_duration_parses_ffprobe_json(monkeypatch):
    fake_stdout = json.dumps({"format": {"duration": "12.5"}})
    monkeypatch.setattr(
        upscale.subprocess, "run", MagicMock(return_value=MagicMock(stdout=fake_stdout))
    )

    assert upscale.probe_duration("input.mp4") == 12.5


def test_probe_duration_returns_none_when_missing(monkeypatch):
    fake_stdout = json.dumps({"format": {}})
    monkeypatch.setattr(
        upscale.subprocess, "run", MagicMock(return_value=MagicMock(stdout=fake_stdout))
    )

    assert upscale.probe_duration("input.mp4") is None


def test_upscale_keeps_aspect_ratio_for_4_3_input(monkeypatch):
    # th07(640x480, 4:3)は1280x720に固定すると横方向だけ引き伸ばされて歪むため、
    # アスペクト比を保った960x720になることを確認する(reports/21)。
    monkeypatch.setattr(upscale, "probe_resolution", lambda path: (640, 480))
    monkeypatch.setattr(upscale, "probe_duration", lambda path: None)
    run_mock = MagicMock()
    monkeypatch.setattr(upscale.subprocess, "run", run_mock)

    upscale.upscale_to_720p("in.mp4", "out.mp4")

    cmd = run_mock.call_args[0][0]
    assert cmd[cmd.index("-vf") + 1] == "scale=960:720:flags=lanczos"


def test_upscale_rounds_target_width_to_even(monkeypatch):
    monkeypatch.setattr(upscale, "probe_resolution", lambda path: (853, 480))
    monkeypatch.setattr(upscale, "probe_duration", lambda path: None)
    run_mock = MagicMock()
    monkeypatch.setattr(upscale.subprocess, "run", run_mock)

    upscale.upscale_to_720p("in.mp4", "out.mp4")

    cmd = run_mock.call_args[0][0]
    target = cmd[cmd.index("-vf") + 1]
    width = int(target.split("scale=")[1].split(":")[0])
    assert width % 2 == 0


def test_upscale_reports_progress_at_interval(monkeypatch):
    monkeypatch.setattr(upscale, "probe_resolution", lambda path: (640, 480))
    monkeypatch.setattr(upscale, "probe_duration", lambda path: 10.0)

    clock = {"t": 0.0}

    def fake_monotonic():
        clock["t"] += upscale.PROGRESS_REPORT_INTERVAL_SEC + 1
        return clock["t"]

    monkeypatch.setattr(upscale.time, "monotonic", fake_monotonic)

    fake_proc = MagicMock()
    fake_proc.stdout = iter(
        [
            "out_time_ms=5000000\n",  # 5s / 10s = 50%
            "out_time_ms=9500000\n",  # 9.5s / 10s = 95%
        ]
    )
    fake_proc.returncode = 0
    monkeypatch.setattr(upscale.subprocess, "Popen", MagicMock(return_value=fake_proc))

    reported = []
    upscale.upscale_to_720p("in.mp4", "out.mp4", on_progress=reported.append)

    assert reported == [50.0, 95.0]


def test_upscale_caps_progress_at_99_percent(monkeypatch):
    monkeypatch.setattr(upscale, "probe_resolution", lambda path: (640, 480))
    monkeypatch.setattr(upscale, "probe_duration", lambda path: 10.0)
    monkeypatch.setattr(upscale.time, "monotonic", lambda: 100.0)

    fake_proc = MagicMock()
    # out_time_ms が total_duration を超えるケース(ffmpegの丸め等で稀に起こりうる)。
    fake_proc.stdout = iter(["out_time_ms=11000000\n"])
    fake_proc.returncode = 0
    monkeypatch.setattr(upscale.subprocess, "Popen", MagicMock(return_value=fake_proc))

    reported = []
    upscale.upscale_to_720p("in.mp4", "out.mp4", on_progress=reported.append)

    assert reported == [99.0]


def test_upscale_raises_on_ffmpeg_failure(monkeypatch):
    monkeypatch.setattr(upscale, "probe_resolution", lambda path: (640, 480))
    monkeypatch.setattr(upscale, "probe_duration", lambda path: 10.0)
    monkeypatch.setattr(upscale.time, "monotonic", lambda: 100.0)

    fake_proc = MagicMock()
    fake_proc.stdout = iter(["out_time_ms=1000000\n"])
    fake_proc.returncode = 1
    monkeypatch.setattr(upscale.subprocess, "Popen", MagicMock(return_value=fake_proc))

    with pytest.raises(RuntimeError):
        upscale.upscale_to_720p("in.mp4", "out.mp4", on_progress=lambda p: None)
