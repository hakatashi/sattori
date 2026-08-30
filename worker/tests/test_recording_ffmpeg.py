"""録画・結合・計測に使う ffmpeg/ffprobe コマンドの組み立て。"""

import pytest

from recording import ffmpeg
from recording_helpers import make_config


def test_build_video_ffmpeg_cmd_captures_without_watermark():
    # ウォーターマークはmux_audio_video()側で合成するため、build_video_ffmpeg_cmd()は
    # 常にウォーターマークなしの生キャプチャコマンドを返す(-copytsとoverlayの
    # フレーム同期不具合を避けるため、reports/28参照)。
    config = make_config()
    cmd = ffmpeg.build_video_ffmpeg_cmd(config, 0, 0, 640, 480, "out.video.mp4")

    assert cmd[0] == "ffmpeg"
    assert "-filter_complex" not in cmd
    assert "-f" in cmd and "pulse" not in cmd  # 音声は別プロセス(reports/26)
    assert cmd[-1] == "out.video.mp4"
    assert "libx264" in cmd
    assert "640x480" in cmd
    assert "-copyts" in cmd  # A/V同期補正用の絶対start_time保持(reports/28)


def test_build_audio_ffmpeg_cmd_uses_pulse_source():
    config = make_config()
    cmd = ffmpeg.build_audio_ffmpeg_cmd(config, "out.audio.m4a")

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

    monkeypatch.setattr(ffmpeg.subprocess, "run", fake_run)

    result = ffmpeg.ffprobe_start_time("video.mp4", {})

    assert result == pytest.approx(1784765161.591758)
    assert captured["cmd"][0] == "ffprobe"
    assert "video.mp4" in captured["cmd"]


def test_ffprobe_start_time_returns_none_on_unparsable_output(monkeypatch):
    monkeypatch.setattr(
        ffmpeg.subprocess, "run", lambda cmd, **kwargs: type("Result", (), {"stdout": "N/A\n"})()
    )

    assert ffmpeg.ffprobe_start_time("video.mp4", {}) is None


def test_mux_audio_video_delays_later_starting_audio(monkeypatch):
    monkeypatch.setattr(
        ffmpeg, "ffprobe_start_time",
        lambda path, env: 100.0 if "video" in path else 100.6,
    )
    captured = {}

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        return type("Result", (), {"returncode": 0, "stderr": b""})()

    monkeypatch.setattr(ffmpeg.subprocess, "run", fake_run)

    ok = ffmpeg.mux_audio_video("video.mp4", "audio.m4a", "out.mp4", {}, log=lambda msg: None)

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
        ffmpeg, "ffprobe_start_time",
        lambda path, env: 100.6 if "video" in path else 100.0,
    )
    captured = {}

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        return type("Result", (), {"returncode": 0, "stderr": b""})()

    monkeypatch.setattr(ffmpeg.subprocess, "run", fake_run)

    ffmpeg.mux_audio_video("video.mp4", "audio.m4a", "out.mp4", {}, log=lambda msg: None)

    cmd = captured["cmd"]
    video_idx = cmd.index("video.mp4")
    assert cmd[video_idx - 3] == "-itsoffset"
    assert float(cmd[video_idx - 2]) == pytest.approx(0.6)


def test_mux_audio_video_skips_offset_when_start_time_unavailable(monkeypatch):
    monkeypatch.setattr(ffmpeg, "ffprobe_start_time", lambda path, env: None)
    captured = {}

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        return type("Result", (), {"returncode": 0, "stderr": b""})()

    monkeypatch.setattr(ffmpeg.subprocess, "run", fake_run)

    ffmpeg.mux_audio_video("video.mp4", "audio.m4a", "out.mp4", {}, log=lambda msg: None)

    assert "-itsoffset" not in captured["cmd"]


def test_mux_audio_video_uses_stream_copy(monkeypatch):
    # ウォーターマークはこの関数(録画直後のmux)では合成しない。x11grabの生ptsが
    # wallclockベース(実epoch秒)のまま`-copyts`でfiltergraphに渡ると、ほぼ0起点の
    # ウォーターマーク動画とoverlayのフレーム同期が噛み合わず不発になる不具合が
    # あったため、ウォーターマーク合成はconvert.py側(配信用変換と同時)に移した。
    monkeypatch.setattr(ffmpeg, "ffprobe_start_time", lambda path, env: None)
    captured = {}

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        return type("Result", (), {"returncode": 0, "stderr": b""})()

    monkeypatch.setattr(ffmpeg.subprocess, "run", fake_run)

    ffmpeg.mux_audio_video("video.mp4", "audio.m4a", "out.mp4", {}, log=lambda msg: None)

    cmd = captured["cmd"]
    assert "-filter_complex" not in cmd
    assert "copy" in cmd
