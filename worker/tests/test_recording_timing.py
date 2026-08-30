"""低速録画(Issue #68)の実時間スケーリングと、重複フレーム率の閾値換算。"""

import pytest

from recording import pipeline, timing


# --- 低速録画(Issue #68) ---------------------------------------------------


def test_slow_motion_scale_is_one_when_env_is_absent():
    """`FPS_LIMIT_TARGET_HZ`未設定＝等倍録画。全タイトル共通の既定動作。"""
    assert timing.slow_motion_scale({}) == 1.0


def test_slow_motion_scale_doubles_at_half_frame_rate():
    # 30Hz駆動＝ゲーム内時間の2倍の実時間がかかる(touhou-recorder reports/47)。
    assert timing.slow_motion_scale({"FPS_LIMIT_TARGET_HZ": "30"}) == pytest.approx(2.0)


@pytest.mark.parametrize("value", ["", "0", "-30", "abc", "60", "120"])
def test_slow_motion_scale_clamps_invalid_or_non_slowing_values_to_one(value):
    """不正値・等倍以上はすべて1.0へ丸める。

    このスケールは「ゲームを遅くしたぶん監視側の時間も伸ばす」ためのものなので、
    1.0未満になるとタイムアウトが本来より短くなり、正常な録画を誤って打ち切る。
    """
    assert timing.slow_motion_scale({"FPS_LIMIT_TARGET_HZ": value}) == 1.0


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
