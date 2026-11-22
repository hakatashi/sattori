"""録画速度(倍速録画 Issue #288)の実時間スケーリング。"""

import pytest

from recording import pipeline, timing


# --- 録画速度のスケール ------------------------------------------------------


def test_recording_time_scale_is_one_when_env_is_absent():
    """`FPS_LIMIT_TARGET_HZ`未設定＝等倍録画。全タイトル共通の既定動作。"""
    assert timing.recording_time_scale({}) == 1.0


@pytest.mark.parametrize("hz", ["30", "20", "1"])
def test_recording_time_scale_never_stretches_below_native_rate(hz):
    # 低速録画は廃止した(Issue #391)。60Hz未満が渡っても等倍として扱う。
    assert timing.recording_time_scale({"FPS_LIMIT_TARGET_HZ": hz}) == 1.0


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


# --- フレーム同期キャプチャ(Issue #389) -------------------------------------


def test_frame_sync_mode_is_decided_only_by_capture_mode():
    assert not timing.frame_sync_mode({})
    assert not timing.frame_sync_mode({"CAPTURE_MODE": "realtime"})
    assert timing.frame_sync_mode({"CAPTURE_MODE": "frame_sync"})
    # GPUワーカーかどうか・倍率は経路の分岐に関与しない
    assert timing.frame_sync_mode({"CAPTURE_MODE": "frame_sync", "GPU_WORKER": "1"})


def test_frame_sync_always_records_at_time_scale_one():
    """生動画のチェックポイントのメタデータ`sattori-time-scale`に1.0が書かれ、互換が保たれる。"""
    env = {"CAPTURE_MODE": "frame_sync", "FPS_LIMIT_TARGET_HZ": "120"}
    assert timing.recording_time_scale(env) == 1.0
    assert timing.recording_time_scale({"CAPTURE_MODE": "frame_sync"}) == 1.0
    # CAPTURE_MODEが無ければ従来どおり
    assert timing.recording_time_scale({"FPS_LIMIT_TARGET_HZ": "120"}) == pytest.approx(0.5)
