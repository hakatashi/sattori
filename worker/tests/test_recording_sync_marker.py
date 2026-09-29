"""同期マーカーによるA/V同期補正(Issue #288、touhou-recorder reports/88)。"""

import numpy as np
import pytest

from recording import sync_marker


def test_marker_sequence_is_a_deterministic_plus_minus_one_sequence():
    seq = sync_marker.marker_sequence(1000, 0x2545F491)

    assert set(np.unique(seq)) == {-1.0, 1.0}
    assert np.array_equal(seq, sync_marker.marker_sequence(1000, 0x2545F491))
    assert not np.array_equal(seq, sync_marker.marker_sequence(1000, 1))


def test_locate_finds_the_marker_buried_in_louder_noise():
    """ゲーム音(ここでは乱数ノイズ)に-42dBFS相当の小さなマーカーが埋もれていても見つかる。"""
    rng = np.random.default_rng(0)
    # MODと同じ長さ(131072サンプル)・振幅(256/32768≒-42dBFS)。
    seq = sync_marker.marker_sequence(131072, 0x2545F491)
    signal = rng.normal(0, 0.05, 44100 * 6)
    offset = 88200 + 123
    signal[offset:offset + len(seq)] += seq * (256 / 32768)

    pos, ratio = sync_marker.locate(signal, seq)

    assert pos == pytest.approx(offset, abs=0.5)
    assert ratio >= sync_marker.MIN_PEAK_RATIO


def test_parse_marker_log_reads_the_last_successful_marker(tmp_path):
    log_path = tmp_path / "th08_autoplay.log"
    log_path.write_text(
        "noise\n"
        "SYNC_MARKER played epoch=100.000000 play_call_sec=0.001 rate=44100 samples=131072 "
        "amp=256 seed=0x2545F491 hr=0x00000000\n"
        "SYNC_MARKER played epoch=200.500000 play_call_sec=0.001 rate=88200 samples=131072 "
        "amp=256 seed=0x2545F491 hr=0x00000000\n"
    )

    marker = sync_marker.parse_marker_log(str(log_path))

    assert marker["epoch"] == pytest.approx(200.5)
    assert marker["rate"] == 88200
    assert marker["seed"] == 0x2545F491


def test_parse_marker_log_ignores_a_failed_play(tmp_path):
    log_path = tmp_path / "mod.log"
    log_path.write_text(
        "SYNC_MARKER played epoch=100.000000 play_call_sec=0.001 rate=44100 samples=131072 "
        "amp=256 seed=0x2545F491 hr=0x88780078\n"
    )

    assert sync_marker.parse_marker_log(str(log_path), log=lambda msg: None) is None


def test_parse_marker_log_returns_none_without_a_log(tmp_path):
    assert sync_marker.parse_marker_log(str(tmp_path / "missing.log")) is None


def test_windows_path_maps_to_the_z_drive():
    assert sync_marker.windows_path("/instance/sync_marker.trigger") == "Z:\\instance\\sync_marker.trigger"


class _Config:
    def __init__(self, instance_dir):
        self.instance_dir = instance_dir


def test_clear_trigger_cancels_a_pending_trigger(tmp_path):
    """前の試行が設置前に中断されても、次の試行の開始時に古いタイマーを止める。"""
    config = _Config(str(tmp_path))
    timer = sync_marker.schedule_trigger(config, delay=0.2, log=lambda msg: None)

    sync_marker.clear_trigger(config)
    timer.join(1.0)

    assert not (tmp_path / "sync_marker.trigger").exists()


def test_verify_output_returns_none_when_ffprobe_output_is_unparsable(monkeypatch):
    class _Result:
        stdout = "N/A\n"

    monkeypatch.setattr(sync_marker.subprocess, "run", lambda *a, **k: _Result())

    assert sync_marker.verify_output("/out.mp4", {"rate": 44100}, 100.0) == (None, 0.0)


def test_find_marker_time_returns_none_when_ffmpeg_cannot_run(monkeypatch):
    def fail(*a, **k):
        raise OSError("ffmpeg not found")

    monkeypatch.setattr(sync_marker.subprocess, "run", fail)

    assert sync_marker.find_marker_time("/a.mov", {"rate": 44100, "samples": 10, "seed": 1}) == (None, 0.0)
