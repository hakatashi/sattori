"""MOD が書き出すログの読み取り(マーカー待ち・スコア照合)。"""

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


def test_read_verified_scores_th06c_is_unscaled(tmp_path):
    # th06cはオリジナルth06の完全な再実装だが、スコアの倍率はth06から変わっていない
    # (touhou-recorder reports/75)。ステージ番号・残機・グレイズのRVAは未特定のため、
    # mods/common/score_monitor.hのwidth=0設定によりMODは常にgraze=0を出力する
    # (0ではなく-1を出すtouhou-recorder側の実装とは異なる。graze<0の除外フィルタに
    # 引っかからないことを確認する)。
    log_path = tmp_path / "th06c_autoplay.log"
    log_path.write_text("ScoreMonitor: score=114250700 stage=0 lives=0 graze=0 epoch_ms=1\n")

    assert modlog.read_verified_scores(str(log_path), "th06c") == [114250700]


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


# --- リプレイの再生を確定したキー入力の時刻(Issue #266) ------------------------

# 2026-10-04 12:34:56.000 UTC
_EPOCH_123456 = 1791117296.0
_MARKER = (f"SYNC_MARKER played epoch={_EPOCH_123456:.6f} play_call_sec=0.1 rate=44100 "
           "samples=131072 amp=256 seed=0x2545F491 hr=0x00000000")


def test_find_replay_start_epoch_uses_the_last_step_before_sequence_complete(tmp_path):
    # ローカル時刻がUTC+9(21:34:56)でも、同期マーカー行の epoch= から換算できる。
    log_path = tmp_path / "th08_autoplay.log"
    log_path.write_text(
        f"[21:34:56.000] {_MARKER}\n"
        "[21:34:57.000] Step 3: Enter (select 1st replay file)\n"
        "[21:34:57.700] Step 4: Enter (select default start stage)\n"
        "[21:34:58.400] Step 5: Enter (select normal playback mode, start replay)\n"
        "[21:34:59.100] === th08_replay_autoplay: sequence complete ===\n"
        "[21:35:00.000] FpsMonitor: 300 GetDeviceState calls\n"
    )

    epoch = modlog.find_replay_start_epoch(str(log_path), reference_epoch=_EPOCH_123456)

    assert abs(epoch - (_EPOCH_123456 + 2.4)) < 1e-6


def test_find_replay_start_epoch_ignores_steps_after_sequence_complete(tmp_path):
    log_path = tmp_path / "mod.log"
    log_path.write_text(
        "[12:34:57.000] Step 5: Enter (リプレイ再生開始)\n"
        "[12:34:57.700] === th06c_replay_autoplay: sequence complete ===\n"
        "[12:35:30.000] Step 9: something unrelated\n"
        f"[12:34:56.000] {_MARKER}\n"
    )

    epoch = modlog.find_replay_start_epoch(str(log_path), reference_epoch=_EPOCH_123456)

    assert abs(epoch - (_EPOCH_123456 + 1.0)) < 1e-6


def test_find_replay_start_epoch_handles_midnight_between_the_key_and_the_marker(tmp_path):
    log_path = tmp_path / "mod.log"
    log_path.write_text(
        "[23:59:59.000] Step 5: Enter (start replay playback)\n"
        "[23:59:59.500] === sequence complete ===\n"
        "[00:00:02.000] SYNC_MARKER played epoch=1791158402.000000\n"  # 2026-10-05 00:00:02 UTC
    )

    epoch = modlog.find_replay_start_epoch(str(log_path), reference_epoch=1791158400.0)

    assert abs(epoch - 1791158399.0) < 1e-6


def test_find_replay_start_epoch_falls_back_to_the_local_timezone(tmp_path, monkeypatch):
    monkeypatch.setenv("TZ", "UTC")
    import time
    time.tzset()
    log_path = tmp_path / "mod.log"
    log_path.write_text(
        "[12:34:51.000] Step 5: Enter (start replay playback)\n"
        "[12:34:51.700] === sequence complete ===\n"
    )

    epoch = modlog.find_replay_start_epoch(str(log_path), reference_epoch=_EPOCH_123456)

    assert abs(epoch - (_EPOCH_123456 - 5.0)) < 1e-6


def test_find_replay_start_epoch_returns_none_until_the_sequence_completes(tmp_path):
    log_path = tmp_path / "mod.log"
    log_path.write_text("[12:34:51.000] Step 1: Down x2\n")

    assert modlog.find_replay_start_epoch(str(log_path)) is None
    assert modlog.find_replay_start_epoch(str(tmp_path / "missing.log")) is None
