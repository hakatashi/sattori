"""MOD が書き出すログの読み取り(マーカー待ち・fps暴走・スコア照合)。"""

import pytest

from recording import modlog
from recording_helpers import make_config


def test_game_score_multipliers_includes_th12():
    # th12はthprac_th12.cppのscore(内部値)が画面表示値の1/10(他タイトルと同じ×10系列)。
    # 欠落するとcheck_replay_desync()が倍率1のまま比較し、録画自体は成功するのに
    # デシンク判定が常に不一致(desyncDetected: true)になる静かな不具合になる。
    assert modlog.GAME_SCORE_MULTIPLIERS["th12"] == 10


def test_wait_for_log_marker_finds_existing_marker(tmp_path):
    log_path = tmp_path / "th08_autoplay.log"
    log_path.write_text("some other line\nWaitForStableWindow: stable\n")

    result = modlog.wait_for_log_marker(str(log_path), "WaitForStableWindow: stable", timeout=1, poll_interval=0.01)

    assert result is not None


def test_wait_for_log_marker_times_out_when_absent(tmp_path):
    log_path = tmp_path / "th08_autoplay.log"
    log_path.write_text("unrelated log line\n")

    result = modlog.wait_for_log_marker(str(log_path), "WaitForStableWindow: stable", timeout=0.05, poll_interval=0.01)

    assert result is None


def test_wait_for_log_marker_times_out_when_log_file_missing(tmp_path):
    result = modlog.wait_for_log_marker(
        str(tmp_path / "does-not-exist.log"), "WaitForStableWindow: stable", timeout=0.05, poll_interval=0.01
    )

    assert result is None


def test_scan_fps_runaway_returns_none_when_log_missing(tmp_path):
    assert modlog.scan_fps_runaway(str(tmp_path / "missing.log")) is None


def test_scan_fps_runaway_ignores_values_at_or_below_threshold(tmp_path):
    log_path = tmp_path / "th08_autoplay.log"
    log_path.write_text(
        "FpsMonitor: 300 GetDeviceState calls in 5006 ms (59.9 Hz)\n"
        "FpsMonitor: 300 GetDeviceState calls in 5004 ms (60.0 Hz)\n"
    )

    assert modlog.scan_fps_runaway(str(log_path)) is None


def test_scan_fps_runaway_ignores_single_spike_below_consecutive_requirement(tmp_path):
    # reports/23: 単発のノイズ(実測最大118Hz、直後に正常値へ復帰)は誤検知しない。
    log_path = tmp_path / "th08_autoplay.log"
    log_path.write_text(
        "FpsMonitor: 300 GetDeviceState calls in 5006 ms (59.9 Hz)\n"
        "FpsMonitor: 300 GetDeviceState calls in 2500 ms (118.1 Hz)\n"
        "FpsMonitor: 300 GetDeviceState calls in 5004 ms (60.1 Hz)\n"
    )

    assert modlog.scan_fps_runaway(str(log_path)) is None


def test_scan_fps_runaway_detects_two_consecutive_spikes(tmp_path):
    # reports/22: fps暴走は実測479〜2700Hzがリプレイ全編にわたり持続する。
    log_path = tmp_path / "th08_autoplay.log"
    log_path.write_text(
        "FpsMonitor: 300 GetDeviceState calls in 5006 ms (59.9 Hz)\n"
        "FpsMonitor: 300 GetDeviceState calls in 100 ms (900.0 Hz)\n"
        "FpsMonitor: 300 GetDeviceState calls in 110 ms (850.0 Hz)\n"
    )

    assert modlog.scan_fps_runaway(str(log_path)) == pytest.approx(900.0)


def test_read_verified_scores_returns_empty_list_when_log_missing(tmp_path):
    assert modlog.read_verified_scores(str(tmp_path / "missing.log"), "th20") == []


def test_read_verified_scores_returns_empty_list_when_no_samples(tmp_path):
    log_path = tmp_path / "th08_autoplay.log"
    log_path.write_text("ScoreMonitor: started (module_base=0x00400000 ...)\n")

    assert modlog.read_verified_scores(str(log_path), "th08") == []


def test_read_verified_scores_applies_game_multiplier(tmp_path):
    log_path = tmp_path / "th20_autoplay.log"
    log_path.write_text(
        "ScoreMonitor: score=0 stage=0 lives=0 graze=0 epoch_ms=1\n"
        "ScoreMonitor: score=48123740 stage=7 lives=2 graze=12345 epoch_ms=2\n"
    )

    # th20は内部値が画面表示値の1/10(GAME_SCORE_MULTIPLIERS)。
    assert modlog.read_verified_scores(str(log_path), "th20") == [0, 481237400]


def test_read_verified_scores_th06_is_unscaled(tmp_path):
    log_path = tmp_path / "th06_autoplay.log"
    log_path.write_text("ScoreMonitor: score=925680 stage=1 lives=4 graze=0 epoch_ms=1\n")

    assert modlog.read_verified_scores(str(log_path), "th06") == [925680]


def test_read_verified_scores_drops_garbage_graze_samples(tmp_path):
    # th07/th08はポインタ間接参照方式のため、状態構造体の解放直後に別用途で
    # 再利用されたメモリを読んでしまう「ゴミ値」が末尾に1回だけ記録されることがある
    # (touhou-recorder reports/53)。グレイズが現実的な上限を超えるサンプルは除外する。
    log_path = tmp_path / "th07_autoplay.log"
    log_path.write_text(
        "ScoreMonitor: score=30376604 stage=0 lives=1 graze=2650 epoch_ms=1\n"
        "ScoreMonitor: score=38732440 stage=0 lives=0 graze=39322200 epoch_ms=2\n"
    )

    assert modlog.read_verified_scores(str(log_path), "th07") == [303766040]


def test_check_replay_desync_skips_when_expected_score_missing(tmp_path):
    config = make_config(instance_dir=str(tmp_path))

    assert modlog.check_replay_desync(config, None, log=lambda msg: None) is None


def test_check_replay_desync_skips_when_log_unreadable(tmp_path):
    config = make_config(instance_dir=str(tmp_path))

    assert modlog.check_replay_desync(config, 481237400, log=lambda msg: None) is None


def test_check_replay_desync_returns_false_on_match(tmp_path):
    config = make_config(instance_dir=str(tmp_path))
    with open(config.log_path, "w") as f:
        f.write("ScoreMonitor: score=48123740 stage=7 lives=2 graze=100 epoch_ms=1\n")

    assert modlog.check_replay_desync(config, 481237400, log=lambda msg: None) is False


def test_check_replay_desync_returns_true_on_mismatch(tmp_path):
    config = make_config(instance_dir=str(tmp_path))
    with open(config.log_path, "w") as f:
        f.write("ScoreMonitor: score=40000000 stage=6 lives=0 graze=100 epoch_ms=1\n")

    assert modlog.check_replay_desync(config, 481237400, log=lambda msg: None) is True


def test_check_replay_desync_matches_even_if_a_later_sample_is_garbage(tmp_path):
    # touhou-recorder reports/54(th07 ver1.00b)で判明した新パターンのゴミ値:
    # リプレイ終了直後、グレイズは直前と同一のままスコアだけ壊れることがある
    # (グレイズが正常範囲内のため GRAZE_GARBAGE_MAX では弾けない)。「最後の
    # サンプル」だけを見ると誤って不一致と判定するが、記録全体から記録スコアと
    # 完全一致するサンプルを探す方式なら正しく一致と判定できる。
    config = make_config(instance_dir=str(tmp_path))
    with open(config.log_path, "w") as f:
        f.write(
            "ScoreMonitor: score=30376604 stage=0 lives=1 graze=2650 epoch_ms=1\n"
            "ScoreMonitor: score=38797976 stage=0 lives=1 graze=2650 epoch_ms=2\n"
        )

    assert modlog.check_replay_desync(config, 303766040, log=lambda msg: None) is False
