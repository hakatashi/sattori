"""配信版から落とすリプレイ再生区間外のカット範囲(Issue #266)。"""

from recording import cut
from recording_helpers import make_config


def _stub(monkeypatch, *, v_start=1000.0, v_offset=0.0, start_epoch=1005.0):
    monkeypatch.setattr(cut, "ffprobe_start_time", lambda path, env: v_start)
    monkeypatch.setattr(cut, "output_video_offset", lambda path, env: v_offset)
    monkeypatch.setattr(cut, "find_replay_start_epoch", lambda path, reference_epoch=None: start_epoch)


def _compute(time_scale=1.0, content_end_epoch=1100.0):
    return cut.compute_cut_range(
        make_config(), "/out.video.mp4", "/out.mp4", {}, time_scale=time_scale,
        content_end_epoch=content_end_epoch, reference_epoch=1000.0, log=lambda msg: None,
    )


def test_starts_one_second_before_the_replay_playback_is_confirmed(monkeypatch):
    _stub(monkeypatch)

    assert _compute() == {"startSec": 4.0, "endSec": 100.0}


def test_accounts_for_the_video_offset_in_the_muxed_file(monkeypatch):
    # 音声の方が先に始まり、mux時に映像を0.3秒後ろへずらした録画。
    _stub(monkeypatch, v_offset=0.3)

    assert _compute() == {"startSec": 4.3, "endSec": 100.3}


def test_lead_time_is_in_game_time_for_a_speedup_recording(monkeypatch):
    # 2倍速では実時間0.5秒がゲーム内1秒。
    _stub(monkeypatch)

    assert _compute(time_scale=0.5)["startSec"] == 4.5


def test_does_not_cut_the_start_without_the_replay_start_line(monkeypatch):
    _stub(monkeypatch, start_epoch=None)

    assert _compute() == {"startSec": None, "endSec": 100.0}


def test_starts_at_the_video_without_the_replay_start_line(monkeypatch):
    # 音声の録音は映像より先に始まる(同期マーカーをメニュー操作の前に鳴らすため)。
    # 映像が無い区間(静止画で埋まるだけ)は残さない。
    _stub(monkeypatch, start_epoch=None, v_offset=3.5)

    assert _compute()["startSec"] == 3.5


def test_does_not_cut_the_end_without_a_detected_end(monkeypatch):
    _stub(monkeypatch)

    assert _compute(content_end_epoch=None) == {"startSec": 4.0, "endSec": None}


def test_drops_an_end_before_the_start(monkeypatch):
    _stub(monkeypatch)

    assert _compute(content_end_epoch=1004.5) == {"startSec": 4.0, "endSec": None}


def test_never_starts_before_the_video(monkeypatch):
    _stub(monkeypatch, start_epoch=1000.2, v_offset=3.5)

    assert _compute()["startSec"] == 3.5


def test_does_not_cut_when_the_video_start_is_unknown(monkeypatch):
    _stub(monkeypatch, v_start=None)

    assert _compute() == {"startSec": None, "endSec": None}


def test_starts_after_the_sync_marker_when_it_overlaps(monkeypatch):
    # マーカー(1001.0から2.97秒)の鳴り終わり+余裕0.3秒=映像の4.27秒が、本来の開始(4.0秒)より後ろ。
    _stub(monkeypatch)
    monkeypatch.setattr(cut.sync_marker, "parse_marker_log", lambda path, log=print: {
        "epoch": 1001.0, "samples": 131072, "rate": 44100,
    })

    start = _compute()["startSec"]

    assert abs(start - (1.0 + 131072 / 44100 + cut.MARKER_TAIL_MARGIN_SEC)) < 1e-9


def test_keeps_the_lead_when_the_sync_marker_ended_earlier(monkeypatch):
    _stub(monkeypatch)
    monkeypatch.setattr(cut.sync_marker, "parse_marker_log", lambda path, log=print: {
        "epoch": 999.0, "samples": 131072, "rate": 176400,
    })

    assert _compute()["startSec"] == 4.0
