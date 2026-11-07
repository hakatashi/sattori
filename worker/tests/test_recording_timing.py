"""録画速度(倍速録画 Issue #288・低速録画 Issue #316)の実時間スケーリング。"""

import pytest

from recording import pipeline, timing


# --- 録画速度のスケール ------------------------------------------------------


def test_recording_time_scale_is_one_when_env_is_absent():
    """`FPS_LIMIT_TARGET_HZ`未設定＝等倍録画。全タイトル共通の既定動作。"""
    assert timing.recording_time_scale({}) == 1.0


@pytest.mark.parametrize("hz,scale", [("30", 2.0), ("20", 3.0)])
def test_recording_time_scale_stretches_for_slow_motion(hz, scale):
    # 低速録画(Issue #316)。実時間がゲーム内時間の2倍・3倍かかる。
    assert timing.recording_time_scale({"FPS_LIMIT_TARGET_HZ": hz}) == pytest.approx(scale)


def test_recording_time_scale_caps_slow_motion_at_one_third():
    """検証していない遅さが来ても、監視のタイムアウトが際限なく伸びないようにする。"""
    assert timing.recording_time_scale({"FPS_LIMIT_TARGET_HZ": "1"}) == pytest.approx(3.0)


@pytest.mark.parametrize("scale", [2.0, 3.0])
def test_slow_motion_keeps_native_capture_and_audio_rate(scale):
    assert not timing.is_speedup(scale)
    assert timing.speedup_multiplier(scale) == 1.0
    assert timing.capture_frame_rate_hz(scale) == 60
    assert timing.audio_capture_rate_hz(scale) is None


@pytest.mark.parametrize("scale,expected", [(0.5, 20), (1.0, 20), (2.0, 40), (3.0, 60)])
def test_scaled_timeout_sec_stretches_only_for_slow_motion(scale, expected):
    assert timing.scaled_timeout_sec(20, scale) == expected


@pytest.mark.parametrize("scale,threshold", [(0.5, 30.0), (1.0, 30.0), (2.0, 90.0), (3.0, 90.0)])
def test_duplicate_rate_threshold_for_raw(scale, threshold):
    assert timing.duplicate_rate_threshold_for_raw(30.0, scale) == threshold


@pytest.mark.parametrize("measured", [58.0, 80.4])
def test_duplicate_rate_threshold_accepts_normal_slow_motion(measured):
    # 正常な録画の実測(30Hz・20Hz、touhou-recorder reports/91 §4)を破棄しない。
    assert measured < timing.duplicate_rate_threshold_for_raw(30.0, 3.0)


@pytest.mark.parametrize("hz,scale", [("120", 0.5), ("180", 1 / 3), ("240", 0.25)])
def test_recording_time_scale_shrinks_for_speedup(hz, scale):
    # 倍速録画(Issue #288)。2倍速(120Hz)ならゲーム内時間の半分の実時間で済む。
    assert timing.recording_time_scale({"FPS_LIMIT_TARGET_HZ": hz}) == pytest.approx(scale)


def test_recording_time_scale_caps_speedup_at_four_times():
    """起動側の不具合で極端な値が来ても、監視のタイムアウトが際限なく縮まないようにする。"""
    assert timing.recording_time_scale({"FPS_LIMIT_TARGET_HZ": "6000"}) == pytest.approx(0.25)


@pytest.mark.parametrize("value", ["", "0", "-30", "abc", "60"])
def test_recording_time_scale_treats_invalid_or_native_values_as_one(value):
    assert timing.recording_time_scale({"FPS_LIMIT_TARGET_HZ": value}) == 1.0


def test_speedup_helpers():
    assert timing.is_speedup(0.5) and not timing.is_speedup(1.0)
    assert timing.speedup_multiplier(0.5) == pytest.approx(2.0)
    assert timing.speedup_multiplier(1.0) == 1.0


@pytest.mark.parametrize("scale,fps", [(1.0, 60), (0.5, 120), (1 / 3, 180), (0.25, 240)])
def test_capture_frame_rate_follows_the_game(scale, fps):
    """倍速録画はゲームが60N fpsで描くのでキャプチャも60N fps。"""
    assert timing.capture_frame_rate_hz(scale) == fps


@pytest.mark.parametrize("scale,rate", [(1.0, None), (0.5, 88200), (1 / 3, 132300), (0.25, 176400)])
def test_audio_capture_rate_matches_the_games_scaled_output_rate(scale, rate):
    assert timing.audio_capture_rate_hz(scale) == rate


def test_scaled_confirmation_count_never_shrinks_for_speedup():
    """終了テンプレートの連続一致は偶然一致を弾くためのもの。倍速でも2回を下回らせない。"""
    assert timing.scaled_confirmation_count(2, 0.5) == 2
    assert timing.scaled_confirmation_count(2, 0.25) == 2


def test_gpu_worker_is_enabled_only_by_explicit_flag():
    assert timing.gpu_worker({"GPU_WORKER": "1"})
    assert not timing.gpu_worker({})
    assert not timing.gpu_worker({"GPU_WORKER": "0"})


def test_scaled_poll_count_is_unchanged_for_normal_speed_recordings():
    assert timing.scaled_poll_count(pipeline.STILL_CONSECUTIVE_REQUIRED, 1.0) == 8
    assert timing.scaled_poll_count(pipeline.END_TEMPLATE_CONSECUTIVE_REQUIRED, 1.0) == 2


def test_scaled_poll_count_keeps_the_required_duration_in_game_time():
    """終了検知の連続回数は「実時間の長さ」なので、倍速録画では縮める必要がある。"""
    assert timing.scaled_poll_count(pipeline.STILL_CONSECUTIVE_REQUIRED, 0.5) == 4


def test_scaled_poll_count_rounds_up_so_the_condition_never_loosens():
    assert timing.scaled_poll_count(3, 0.75) == 3  # 2.25 -> 3
