"""録画速度(倍速録画 Issue #288・低速録画 Issue #68)の実時間スケーリングと、重複フレーム率の閾値換算。"""

import pytest

from recording import pipeline, timing


# --- 録画速度のスケール ------------------------------------------------------


def test_recording_time_scale_is_one_when_env_is_absent():
    """`FPS_LIMIT_TARGET_HZ`未設定＝等倍録画。全タイトル共通の既定動作。"""
    assert timing.recording_time_scale({}) == 1.0


def test_recording_time_scale_doubles_at_half_frame_rate():
    # 30Hz駆動＝ゲーム内時間の2倍の実時間がかかる(touhou-recorder reports/47)。
    assert timing.recording_time_scale({"FPS_LIMIT_TARGET_HZ": "30"}) == pytest.approx(2.0)


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
    assert timing.is_speedup(0.5) and not timing.is_speedup(1.0) and not timing.is_speedup(2.0)
    assert timing.speedup_multiplier(0.5) == pytest.approx(2.0)
    # 低速録画は「倍速の倍率」としては1.0(QPC偽装を掛けない)。
    assert timing.speedup_multiplier(2.0) == 1.0


@pytest.mark.parametrize("scale,fps", [(1.0, 60), (2.0, 60), (0.5, 120), (1 / 3, 180), (0.25, 240)])
def test_capture_frame_rate_follows_the_game_only_for_speedup(scale, fps):
    """倍速録画はゲームが60N fpsで描くのでキャプチャも60N fps。低速録画は60fpsのまま。"""
    assert timing.capture_frame_rate_hz(scale) == fps


@pytest.mark.parametrize("scale,rate", [(1.0, None), (2.0, None), (0.5, 88200), (1 / 3, 132300), (0.25, 176400)])
def test_audio_capture_rate_matches_the_games_scaled_output_rate(scale, rate):
    assert timing.audio_capture_rate_hz(scale) == rate


def test_scaled_confirmation_count_never_shrinks_for_speedup():
    """終了テンプレートの連続一致は偶然一致を弾くためのもの。倍速でも2回を下回らせない。"""
    assert timing.scaled_confirmation_count(2, 0.5) == 2
    assert timing.scaled_confirmation_count(2, 0.25) == 2
    assert timing.scaled_confirmation_count(2, 2.0) == 4


def test_scaled_timeout_never_shrinks_for_speedup():
    """起動・メニュー操作は実時間で進むので、倍速録画でもタイムアウトを縮めない(reports/90)。"""
    assert timing.scaled_timeout_sec(20, 0.5) == 20
    assert timing.scaled_timeout_sec(20, 2.0) == 40


def test_gpu_worker_is_enabled_only_by_explicit_flag():
    assert timing.gpu_worker({"GPU_WORKER": "1"})
    assert not timing.gpu_worker({})
    assert not timing.gpu_worker({"GPU_WORKER": "0"})


def test_scaled_poll_count_is_unchanged_for_normal_speed_recordings():
    assert timing.scaled_poll_count(pipeline.STILL_CONSECUTIVE_REQUIRED, 1.0) == 8
    assert timing.scaled_poll_count(pipeline.END_TEMPLATE_CONSECUTIVE_REQUIRED, 1.0) == 2


def test_scaled_poll_count_keeps_the_required_duration_in_game_time():
    """終了検知の連続回数は「実時間の長さ」なので、低速録画では伸ばす必要がある。

    据え置くと、th20(低速録画で唯一のタイトルかつ終了検知テンプレートを持たない)で
    必要な静止が16秒→ゲーム内8秒相当まで縮み、会話イベント等でリプレイ途中を
    終了と誤判定する。しかも classification は "good" になるためリトライされない。
    """
    assert timing.scaled_poll_count(pipeline.STILL_CONSECUTIVE_REQUIRED, 2.0) == 16
    assert timing.scaled_poll_count(pipeline.END_TEMPLATE_CONSECUTIVE_REQUIRED, 2.0) == 4


def test_scaled_poll_count_rounds_up_so_the_condition_never_loosens():
    assert timing.scaled_poll_count(3, 1.5) == 5  # 4.5 -> 5


# --- 重複フレーム率の閾値換算(Issue #68) ----------------------------------


def test_duplicate_rate_threshold_is_unchanged_for_normal_speed_recordings():
    """等倍(scale=1)では換算しても値が変わらない＝既存タイトルの判定は不変。"""
    assert timing.duplicate_rate_threshold_for_raw(30.0, 1.0) == 30.0


def test_duplicate_rate_threshold_accounts_for_the_frames_slow_motion_duplicates():
    """1/2倍速の生データは、完璧に目標fpsを維持していても重複50%になる。

    等倍換算の閾値30%は、生データでは65%に相当する。
    """
    assert timing.duplicate_rate_threshold_for_raw(30.0, 2.0) == pytest.approx(65.0)


def test_duplicate_rate_threshold_passes_a_healthy_slow_motion_recording():
    # 目標fpsを完璧に維持できた低速録画の生データは重複50%。閾値を換算しないと
    # 正常な録画が必ず「処理落ち」と判定されてリトライされてしまう。
    threshold = timing.duplicate_rate_threshold_for_raw(pipeline.MAX_DUPLICATE_RATE_DEFAULT, 2.0)
    assert 50.0 <= threshold


def test_duplicate_rate_threshold_still_catches_a_real_stutter():
    # 目標30fpsのはずが実際には15fpsしか出ていない生データは重複75%で、換算後の
    # 閾値(65%)を超えるので正しくリトライされる。
    threshold = timing.duplicate_rate_threshold_for_raw(pipeline.MAX_DUPLICATE_RATE_DEFAULT, 2.0)
    assert 75.0 > threshold


def test_duplicate_rate_threshold_is_not_converted_for_speedup():
    """倍速録画はキャプチャ自体を60N fpsで撮るので構造的な重複は無く、換算しない。

    低速録画用の換算式をそのまま当てると負の閾値になり、重複率0%でも必ず超過判定される
    (touhou-recorder reports/85)。
    """
    assert timing.duplicate_rate_threshold_for_raw(30.0, 0.5) == 30.0
    assert timing.duplicate_rate_threshold_for_raw(30.0, 0.25) == 30.0
