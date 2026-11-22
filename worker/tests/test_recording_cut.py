"""配信版から落とすリプレイ再生区間外のカット範囲(Issue #266)。"""

import pytest

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


# --- フレーム同期キャプチャ(Issue #389) -------------------------------------

_FRAME_SYNC_LOG = [
    "[00:00:02.000] FrameSync: capture start width=640 height=480 d3dfmt=21 pix_fmt=bgr0 multisample=0",
    "[00:00:09.000] Step 5: Enter (start replay)",
    "[00:00:09.700] FrameSync: unthrottled=1 at frame=700",
    "[00:00:09.701] === th08_replay_autoplay: sequence complete ===",
]


def _frame_sync_config(tmp_path, lines=_FRAME_SYNC_LOG):
    config = make_config(instance_dir=str(tmp_path))
    with open(config.log_path, "w") as f:
        f.write("\n".join(lines) + "\n")
    return config


def test_frame_sync_cut_starts_one_second_before_the_replay_start_frame(tmp_path):
    config = _frame_sync_config(tmp_path)
    result = cut.compute_frame_sync_cut_range(config, 700.0, log=lambda m: None)
    # リプレイ再生確定 = 700 - 42 = 658フレーム目(10.967秒)。その1秒前から残す
    assert result["startSec"] == pytest.approx(658 / 60 - 1.0)
    assert result["endSec"] == 700.0


def test_frame_sync_cut_uses_video_time_not_wall_clock(tmp_path):
    """壁時計(epoch)の情報は使わない。同期マーカーも鳴らさないのでその配慮も無い。"""
    config = _frame_sync_config(tmp_path)
    assert cut.compute_frame_sync_cut_range(config, None, log=lambda m: None)["endSec"] is None


def test_frame_sync_cut_keeps_the_start_when_the_log_has_no_frame(tmp_path):
    config = _frame_sync_config(tmp_path, ["[00:00:02.000] Step 1: Enter"])
    result = cut.compute_frame_sync_cut_range(config, 100.0, log=lambda m: None)
    assert result == {"startSec": None, "endSec": 100.0}


def test_frame_sync_cut_drops_an_end_too_close_to_the_start(tmp_path):
    config = _frame_sync_config(tmp_path)
    result = cut.compute_frame_sync_cut_range(config, 10.5, log=lambda m: None)
    assert result["endSec"] is None
