"""1回の録画試行と、その自動リトライ。"""

import json
import subprocess

import numpy as np
import pytest

import pulse
from recording import pipeline
from recording_helpers import make_config


@pytest.fixture(autouse=True)
def fake_job_sink(monkeypatch):
    """テスト中に実際のpactl(PulseAudio)を叩かせない(このモジュール限定のautouse)。

    record_with_retry()がジョブ専用sinkを作成・破棄する(Issue #48)ため、pulse側の
    pactl実行部分だけを差し替え、呼び出し履歴を返す(sinkのライフサイクル自体は
    本物のpulse.job_sink()を通す)。
    """
    events = []

    def create_null_sink(sink_name, log=print):
        events.append(("create", sink_name))
        return "42"

    def unload_module(module_id, log=print):
        events.append(("unload", module_id))
        return True

    monkeypatch.setattr(pulse, "create_null_sink", create_null_sink)
    monkeypatch.setattr(pulse, "unload_module", unload_module)
    return events


def test_record_with_retry_writes_desync_result_on_success(monkeypatch, tmp_path):
    config = make_config()
    monkeypatch.setattr(pipeline, "attempt_recording", lambda *a, **k: {
        "output_exists": True, "classification": "good", "total_record_sec": 60.0,
    })
    monkeypatch.setattr(pipeline, "measure_duplicate_rate", lambda *a, **k: 1.0)
    monkeypatch.setattr(pipeline, "check_replay_desync", lambda *a, **k: True)
    result_path = str(tmp_path / "desync_result.json")

    success = pipeline.record_with_retry(
        config, "/replay.rpy", "/out.mp4", max_attempts=1,
        expected_score=481237400, desync_result_path=result_path, log=lambda msg: None,
    )

    assert success is True
    with open(result_path) as f:
        assert json.load(f) == {"desyncDetected": True}


def test_record_with_retry_writes_timed_out_true_on_timeout_classification(monkeypatch, tmp_path):
    # 検知方式がタイムアウトでも録画自体は成功扱いになる(Issue #161)が、
    # timedOut:true として記録され、フロントの警告表示に使われる。
    config = make_config()
    monkeypatch.setattr(pipeline, "attempt_recording", lambda *a, **k: {
        "output_exists": True, "classification": "timeout", "total_record_sec": 60.0,
    })
    monkeypatch.setattr(pipeline, "measure_duplicate_rate", lambda *a, **k: 1.0)
    monkeypatch.setattr(pipeline, "check_replay_desync", lambda *a, **k: None)
    result_path = str(tmp_path / "timeout_result.json")

    success = pipeline.record_with_retry(
        config, "/replay.rpy", "/out.mp4", max_attempts=1,
        timeout_result_path=result_path, log=lambda msg: None,
    )

    assert success is True
    with open(result_path) as f:
        assert json.load(f) == {"timedOut": True}


def test_record_with_retry_writes_timed_out_false_on_good_classification(monkeypatch, tmp_path):
    config = make_config()
    monkeypatch.setattr(pipeline, "attempt_recording", lambda *a, **k: {
        "output_exists": True, "classification": "good", "total_record_sec": 60.0,
    })
    monkeypatch.setattr(pipeline, "measure_duplicate_rate", lambda *a, **k: 1.0)
    monkeypatch.setattr(pipeline, "check_replay_desync", lambda *a, **k: None)
    result_path = str(tmp_path / "timeout_result.json")

    success = pipeline.record_with_retry(
        config, "/replay.rpy", "/out.mp4", max_attempts=1,
        timeout_result_path=result_path, log=lambda msg: None,
    )

    assert success is True
    with open(result_path) as f:
        assert json.load(f) == {"timedOut": False}


def test_record_with_retry_logs_warning_on_timeout_classification(monkeypatch):
    config = make_config()
    monkeypatch.setattr(pipeline, "attempt_recording", lambda *a, **k: {
        "output_exists": True, "classification": "timeout", "total_record_sec": 60.0,
    })
    monkeypatch.setattr(pipeline, "measure_duplicate_rate", lambda *a, **k: 1.0)
    monkeypatch.setattr(pipeline, "check_replay_desync", lambda *a, **k: None)
    logs = []

    pipeline.record_with_retry(config, "/replay.rpy", "/out.mp4", max_attempts=1, log=logs.append)

    assert any("WARNING" in msg and "タイムアウト" in msg for msg in logs)


def test_record_with_retry_gives_up_after_max_attempts(monkeypatch):
    config = make_config()
    monkeypatch.setattr(pipeline, "attempt_recording", lambda *a, **k: {
        "output_exists": False, "classification": "setup_error", "total_record_sec": 0.0,
    })

    success = pipeline.record_with_retry(config, "/replay.rpy", "/out.mp4", max_attempts=2, log=lambda msg: None)

    assert success is False


def test_record_with_retry_retries_when_output_missing_then_succeeds(monkeypatch):
    config = make_config()
    calls = []

    def fake_attempt(*args, **kwargs):
        calls.append(1)
        if len(calls) == 1:
            return {"output_exists": False, "classification": "setup_error", "total_record_sec": 5.0}
        return {"output_exists": True, "classification": "good", "total_record_sec": 60.0}

    monkeypatch.setattr(pipeline, "attempt_recording", fake_attempt)
    monkeypatch.setattr(pipeline, "measure_duplicate_rate", lambda *a, **k: 1.0)

    success = pipeline.record_with_retry(config, "/replay.rpy", "/out.mp4", max_attempts=3, log=lambda msg: None)

    assert success is True
    assert len(calls) == 2


def test_record_with_retry_discards_output_above_max_duplicate_rate(monkeypatch):
    config = make_config()
    monkeypatch.setattr(pipeline, "attempt_recording", lambda *a, **k: {
        "output_exists": True, "classification": "good", "total_record_sec": 60.0,
    })
    monkeypatch.setattr(pipeline, "measure_duplicate_rate", lambda *a, **k: 90.0)

    success = pipeline.record_with_retry(
        config, "/replay.rpy", "/out.mp4", max_attempts=1, max_duplicate_rate=30.0, log=lambda msg: None
    )

    assert success is False


def test_record_with_retry_discards_and_retries_on_crashed_classification(monkeypatch):
    """Wineクラッシュ(classification="crashed")はデシンクと異なり非決定的で
    リトライにより解消しうる(同一リプレイの2ジョブが別地点でクラッシュした実例、
    Issue #267)ため、理論尺・重複フレーム率チェックを待たず直ちに破棄してリトライ
    すること。重複フレーム率チェックは無駄なので、破棄した試行では呼ばれないこと
    も確認する。"""
    config = make_config()
    calls = []
    dup_rate_calls = []

    def fake_attempt(*args, **kwargs):
        calls.append(1)
        if len(calls) == 1:
            return {"output_exists": True, "classification": "crashed", "total_record_sec": 30.0}
        return {"output_exists": True, "classification": "good", "total_record_sec": 60.0}

    def fake_measure_duplicate_rate(*args, **kwargs):
        dup_rate_calls.append(1)
        return 1.0

    monkeypatch.setattr(pipeline, "attempt_recording", fake_attempt)
    monkeypatch.setattr(pipeline, "measure_duplicate_rate", fake_measure_duplicate_rate)

    logs = []
    success = pipeline.record_with_retry(config, "/replay.rpy", "/out.mp4", max_attempts=3, log=logs.append)

    assert success is True
    assert len(calls) == 2
    assert dup_rate_calls == [1]  # 破棄されたcrashed試行では呼ばれない(2回目のgoodでのみ呼ばれる)
    assert any("WARNING" in msg and "クラッシュ" in msg for msg in logs)


def test_record_with_retry_gives_up_after_max_attempts_when_always_crashed(monkeypatch):
    config = make_config()
    monkeypatch.setattr(pipeline, "attempt_recording", lambda *a, **k: {
        "output_exists": True, "classification": "crashed", "total_record_sec": 30.0,
    })

    success = pipeline.record_with_retry(config, "/replay.rpy", "/out.mp4", max_attempts=2, log=lambda msg: None)

    assert success is False


def test_record_with_retry_creates_and_destroys_job_sink(monkeypatch, fake_job_sink):
    # ジョブ専用sinkは録画開始時に作成し、終了時に必ず破棄する(Issue #48)。
    config = make_config(pulse_sink="sattori_job_abc")
    monkeypatch.setattr(pipeline, "attempt_recording", lambda *a, **k: {
        "output_exists": True, "classification": "good", "total_record_sec": 60.0,
    })
    monkeypatch.setattr(pipeline, "measure_duplicate_rate", lambda *a, **k: 1.0)

    success = pipeline.record_with_retry(config, "/replay.rpy", "/out.mp4", max_attempts=1, log=lambda msg: None)

    assert success is True
    assert fake_job_sink == [("create", "sattori_job_abc"), ("unload", "42")]


def test_record_with_retry_destroys_job_sink_when_recording_fails(monkeypatch, fake_job_sink):
    # 失敗時に残った孤児sinkは、次のジョブで同名sinkが`<名前>.2`にリネームされる原因に
    # なるため、成功・失敗を問わず破棄する。
    config = make_config(pulse_sink="sattori_job_abc")
    monkeypatch.setattr(pipeline, "attempt_recording", lambda *a, **k: {
        "output_exists": False, "classification": "setup_error", "total_record_sec": 0.0,
    })

    success = pipeline.record_with_retry(config, "/replay.rpy", "/out.mp4", max_attempts=2, log=lambda msg: None)

    assert success is False
    assert fake_job_sink == [("create", "sattori_job_abc"), ("unload", "42")]


def test_record_with_retry_reuses_single_sink_across_attempts(monkeypatch, fake_job_sink):
    config = make_config(pulse_sink="sattori_job_abc")
    calls = []

    def fake_attempt(*args, **kwargs):
        calls.append(1)
        if len(calls) == 1:
            return {"output_exists": False, "classification": "setup_error", "total_record_sec": 5.0}
        return {"output_exists": True, "classification": "good", "total_record_sec": 60.0}

    monkeypatch.setattr(pipeline, "attempt_recording", fake_attempt)
    monkeypatch.setattr(pipeline, "measure_duplicate_rate", lambda *a, **k: 1.0)

    assert pipeline.record_with_retry(config, "/replay.rpy", "/out.mp4", max_attempts=3, log=lambda msg: None) is True
    assert len(calls) == 2
    assert [event for event, _ in fake_job_sink] == ["create", "unload"]


def test_record_with_retry_recovers_from_unexpected_exception_and_retries(monkeypatch):
    """attempt_recording()自体が(kill_wine_and_wait()を呼ぶ前に)想定外の例外を送出しても、
    リトライループが例外ごとクラッシュせず後片付けして次の試行へ進むこと(2026-08-27
    インシデント: D stateのゲームプロセス相手にwineserver -wがTimeoutExpiredを送出し、
    それが未捕捉のままリトライループごとスクリプトをクラッシュさせ、wineserver/
    winedeviceがホストに取り残された)。"""
    config = make_config()
    calls = []
    cleanup_calls = []

    def fake_attempt(*args, **kwargs):
        calls.append(1)
        if len(calls) == 1:
            raise subprocess.TimeoutExpired("wineserver", 60)
        return {"output_exists": True, "classification": "good", "total_record_sec": 60.0}

    monkeypatch.setattr(pipeline, "attempt_recording", fake_attempt)
    monkeypatch.setattr(pipeline, "measure_duplicate_rate", lambda *a, **k: 1.0)
    monkeypatch.setattr(
        pipeline, "kill_wine_and_wait",
        lambda cfg, env, process_name, log=print: cleanup_calls.append(process_name),
    )

    logs = []
    success = pipeline.record_with_retry(config, "/replay.rpy", "/out.mp4", max_attempts=3, log=logs.append)

    assert success is True
    assert len(calls) == 2
    assert cleanup_calls == [config.process_name]
    assert any("ERROR" in msg for msg in logs)


def test_record_with_retry_gives_up_after_max_attempts_on_repeated_exceptions(monkeypatch):
    """後片付け自体が失敗し続けても、リトライループは例外を外へ伝播させず
    max_attempts回で諦めて安全にFalseを返すこと。"""
    config = make_config()

    def always_raise(*args, **kwargs):
        raise RuntimeError("boom")

    monkeypatch.setattr(pipeline, "attempt_recording", always_raise)
    monkeypatch.setattr(pipeline, "kill_wine_and_wait", always_raise)

    success = pipeline.record_with_retry(config, "/replay.rpy", "/out.mp4", max_attempts=2, log=lambda msg: None)

    assert success is False


class _FakeClock:
    """time.time()/time.sleep()を差し替え、_monitor_until_end()のポーリングループを
    実時間を待たずに進める(Issue #159のテスト用)。"""

    def __init__(self):
        self.t = 0.0

    def time(self):
        return self.t

    def sleep(self, seconds):
        self.t += seconds


def test_settle_crop_geometry_moves_window_when_position_is_negative(monkeypatch):
    """ウィンドウマネージャが左上の外側(負座標)にウィンドウを配置した場合も
    画面外とみなしてwindowmoveする。従来は右・下へのはみ出し
    (x + w > screen_w等)しか見ておらず、負座標配置を「画面内」と誤判定して
    空の録画がそのまま正常扱いになっていた(GPU描画のXorg+nvidia環境で実際に
    発生、touhou-recorder reports/81 §9.9.5、Issue #241)。"""
    config = make_config()  # xvfb_screen既定 "800x600x24"
    calls = []
    monkeypatch.setattr(pipeline, "find_window", lambda *a, **k: (-3, -16, 640, 480, "0x1"))
    monkeypatch.setattr(pipeline, "attach_thprac", lambda *a, **k: None)
    monkeypatch.setattr(pipeline, "wait_for_log_marker", lambda *a, **k: 1.0)
    geometries = iter([
        (-3, -16, 640, 480, "0x1"),  # 確定直後の座標(画面外)
        (0, 0, 640, 480, "0x1"),  # windowmove後の座標
    ])
    monkeypatch.setattr(pipeline, "wait_for_stable_geometry", lambda *a, **k: next(geometries))
    monkeypatch.setattr(pipeline.subprocess, "run", lambda cmd, **k: calls.append(list(cmd)))

    result = pipeline._settle_crop_geometry(config, {}, 123, set(), log=lambda _m: None)

    assert result == (0, 0, 640, 480)
    assert any(c[:2] == ["xdotool", "windowmove"] for c in calls)


def test_settle_crop_geometry_skips_move_when_within_bounds(monkeypatch):
    config = make_config()
    calls = []
    monkeypatch.setattr(pipeline, "find_window", lambda *a, **k: (10, 10, 640, 480, "0x1"))
    monkeypatch.setattr(pipeline, "attach_thprac", lambda *a, **k: None)
    monkeypatch.setattr(pipeline, "wait_for_log_marker", lambda *a, **k: 1.0)
    monkeypatch.setattr(pipeline, "wait_for_stable_geometry", lambda *a, **k: (10, 10, 640, 480, "0x1"))
    monkeypatch.setattr(pipeline.subprocess, "run", lambda cmd, **k: calls.append(list(cmd)))

    result = pipeline._settle_crop_geometry(config, {}, 123, set(), log=lambda _m: None)

    assert result == (10, 10, 640, 480)
    assert calls == []


def test_monitor_until_end_returns_last_captured_frame_on_freeze(monkeypatch):
    """画面固着で打ち切られても、直近にgrab_frame()で取得したカラー画像を返すこと
    (Issue #159。診断スナップショットの元になる)。"""
    config = make_config()
    env = config.build_env()
    clock = _FakeClock()
    monkeypatch.setattr(pipeline.time, "time", clock.time)
    monkeypatch.setattr(pipeline.time, "sleep", clock.sleep)
    monkeypatch.setattr(pipeline, "wait_for_log_marker", lambda *a, **k: 0.0)
    monkeypatch.setattr(pipeline, "FREEZE_CONSECUTIVE_REQUIRED", 2)

    gray = np.zeros((120, 160), dtype=np.float32)
    frames = [(gray, "color0"), (gray, "color1"), (gray, "color2")]
    grab_calls = {"n": 0}

    def fake_grab_frame(*a, **k):
        frame = frames[min(grab_calls["n"], len(frames) - 1)]
        grab_calls["n"] += 1
        return frame

    monkeypatch.setattr(pipeline, "grab_frame", fake_grab_frame)

    end_template = np.zeros((120, 160), dtype=np.float32)
    detection = pipeline._EndDetection(
        template=end_template, template_mask=None, template_mad_threshold=0.0, still_mask=None,
    )
    detected, detected_by, frozen, crashed, last_color_frame = pipeline._monitor_until_end(
        config, env, (0, 0, 640, 480), detection, time_scale=1.0,
        progress_dir=None, expected_duration_seconds=None, seen_lines=set(), log=lambda msg: None,
    )

    assert detected is False
    assert detected_by is None
    assert frozen is True
    assert crashed is False
    assert last_color_frame == "color2"


def test_monitor_until_end_uses_side_stream_when_configured(monkeypatch):
    """poll_side_stream使用時はgrab_frame()(別プロセスのx11grab)ではなく
    read_side_stream_frame()を使う(GPU実行時のキャプチャ競合対策、Issue #241)。"""
    config = make_config(poll_side_stream=True)
    env = config.build_env()
    clock = _FakeClock()
    monkeypatch.setattr(pipeline.time, "time", clock.time)
    monkeypatch.setattr(pipeline.time, "sleep", clock.sleep)
    monkeypatch.setattr(pipeline, "wait_for_log_marker", lambda *a, **k: 0.0)
    monkeypatch.setattr(pipeline, "FREEZE_CONSECUTIVE_REQUIRED", 2)

    def fail_grab_frame(*a, **k):
        raise AssertionError("poll_side_stream時はgrab_frame()を呼んではならない")

    monkeypatch.setattr(pipeline, "grab_frame", fail_grab_frame)

    gray = np.zeros((120, 160), dtype=np.float32)
    side_calls = {"n": 0}

    def fake_read_side_stream_frame(path, last_mtime=None):
        side_calls["n"] += 1
        assert path == "/side.jpg"
        return gray, f"color{side_calls['n']}", float(side_calls["n"])

    monkeypatch.setattr(pipeline, "read_side_stream_frame", fake_read_side_stream_frame)

    end_template = np.zeros((120, 160), dtype=np.float32)
    detection = pipeline._EndDetection(
        template=end_template, template_mask=None, template_mad_threshold=0.0, still_mask=None,
    )
    detected, detected_by, frozen, crashed, last_color_frame = pipeline._monitor_until_end(
        config, env, (0, 0, 640, 480), detection, time_scale=1.0,
        progress_dir=None, expected_duration_seconds=None, seen_lines=set(), log=lambda msg: None,
        side_stream_path="/side.jpg",
    )

    assert frozen is True
    assert side_calls["n"] > 0
    assert last_color_frame == f"color{side_calls['n']}"


def test_monitor_until_end_skips_poll_when_side_stream_frame_unchanged(monkeypatch):
    """フレーム未更新(None)が返された場合はポーリングをスキップして次周期を待つだけで、
    静止・タイムアウト判定を進めない(同一フレームを誤って静止と数えない)。"""
    config = make_config(poll_side_stream=True)
    env = config.build_env()
    clock = _FakeClock()
    monkeypatch.setattr(pipeline.time, "time", clock.time)
    monkeypatch.setattr(pipeline.time, "sleep", clock.sleep)
    monkeypatch.setattr(pipeline, "wait_for_log_marker", lambda *a, **k: 0.0)
    monkeypatch.setattr(pipeline, "TIMEOUT_SEC", 20)

    monkeypatch.setattr(pipeline, "read_side_stream_frame", lambda *a, **k: (None, None, None))

    end_template = np.zeros((120, 160), dtype=np.float32)
    detection = pipeline._EndDetection(
        template=end_template, template_mask=None, template_mad_threshold=0.0, still_mask=None,
    )
    detected, detected_by, frozen, crashed, last_color_frame = pipeline._monitor_until_end(
        config, env, (0, 0, 640, 480), detection, time_scale=1.0,
        progress_dir=None, expected_duration_seconds=None, seen_lines=set(), log=lambda msg: None,
        side_stream_path="/side.jpg",
    )

    assert last_color_frame is None
    assert frozen is False
    assert detected is False


def test_monitor_until_end_detects_wine_crash_via_wine_log(monkeypatch, tmp_path):
    """Wineクラッシュ後にゲーム画面がフリーズしても、静止検知(誤って"good"=正常終了
    扱いになる)より先にwine.logの未処理例外を検知して打ち切ること。3182b7c9・
    d18b4eb3の両インシデントを実機再現実験で確認した結果に基づく
    (Issue #267、docs/reports/2026-09-19-th15-wine-crash-detection-verification.md)。"""
    wine_log = tmp_path / "wine.log"
    wine_log.write_bytes(b"Launching (suspended): ...\nProcess created. PID=216\n")
    config = make_config(instance_dir=str(tmp_path))
    env = config.build_env()
    clock = _FakeClock()
    monkeypatch.setattr(pipeline.time, "time", clock.time)
    monkeypatch.setattr(pipeline.time, "sleep", clock.sleep)
    monkeypatch.setattr(pipeline, "wait_for_log_marker", lambda *a, **k: 0.0)

    gray = np.zeros((120, 160), dtype=np.float32)
    grab_calls = {"n": 0}

    def fake_grab_frame(*a, **k):
        grab_calls["n"] += 1
        # 1回目のフレーム取得と同時にwine.logへクラッシュを書き込む(実機では
        # ゲームプロセスのクラッシュとフリーズしたフレームがほぼ同時に起きる)。
        with open(wine_log, "a") as f:
            f.write(
                "0148:err:seh:NtRaiseException Unhandled exception code "
                "c0000005 flags 0 addr 0x49e93e\n"
            )
        return gray, f"color{grab_calls['n']}"

    monkeypatch.setattr(pipeline, "grab_frame", fake_grab_frame)

    detection = pipeline._EndDetection(
        template=None, template_mask=None, template_mad_threshold=0.0, still_mask=None,
    )
    detected, detected_by, frozen, crashed, last_color_frame = pipeline._monitor_until_end(
        config, env, (0, 0, 640, 480), detection, time_scale=1.0,
        progress_dir=None, expected_duration_seconds=None, seen_lines=set(), log=lambda msg: None,
    )

    assert crashed is True
    assert detected is False
    assert frozen is False
    # wine.logのチェックはフレーム取得より前に行われるため、クラッシュ発生の
    # 次周期(2回目)で検知が成立し、それ以上フレームを取得しない。
    assert grab_calls["n"] == 1


def test_monitor_until_end_ignores_wine_log_content_written_before_monitoring_starts(monkeypatch, tmp_path):
    """wine.logの増分監視は監視開始時点までの内容を対象外とする。過去の試行由来の
    "Unhandled"文字列が既に残っていても誤検知しないこと(_launch_game()はwine.logを
    試行ごとに新規で開くため通常は起こらないが、念のための回帰テスト)。"""
    wine_log = tmp_path / "wine.log"
    wine_log.write_bytes(b"stale: Unhandled leftover from a previous run\n")
    config = make_config(instance_dir=str(tmp_path))
    env = config.build_env()
    clock = _FakeClock()
    monkeypatch.setattr(pipeline.time, "time", clock.time)
    monkeypatch.setattr(pipeline.time, "sleep", clock.sleep)
    monkeypatch.setattr(pipeline, "wait_for_log_marker", lambda *a, **k: 0.0)
    monkeypatch.setattr(pipeline, "STILL_CONSECUTIVE_REQUIRED", 2)

    gray = np.zeros((120, 160), dtype=np.float32)
    monkeypatch.setattr(pipeline, "grab_frame", lambda *a, **k: (gray, "color"))

    detection = pipeline._EndDetection(
        template=None, template_mask=None, template_mad_threshold=0.0, still_mask=None,
    )
    detected, detected_by, frozen, crashed, last_color_frame = pipeline._monitor_until_end(
        config, env, (0, 0, 640, 480), detection, time_scale=1.0,
        progress_dir=None, expected_duration_seconds=None, seen_lines=set(), log=lambda msg: None,
    )

    assert crashed is False
    assert detected is True
    assert detected_by == "still"


def test_attempt_recording_saves_diagnostics_snapshot_on_discarded_attempt(monkeypatch, tmp_path):
    config = make_config()
    monkeypatch.setattr(pipeline, "load_end_template", lambda path: None)
    monkeypatch.setattr(pipeline, "_launch_game", lambda *a, **k: 1234)
    monkeypatch.setattr(pipeline, "_settle_crop_geometry", lambda *a, **k: (0, 0, 640, 480))
    monkeypatch.setattr(pipeline, "build_still_mask", lambda *a, **k: None)
    monkeypatch.setattr(pipeline, "build_end_template_mask", lambda *a, **k: None)
    monkeypatch.setattr(
        pipeline, "_monitor_until_end", lambda *a, **k: (False, None, True, False, "the-last-frame"),
    )
    monkeypatch.setattr(pipeline, "_stop_and_mux", lambda *a, **k: True)
    monkeypatch.setattr(pipeline, "kill_wine_and_wait", lambda *a, **k: None)
    monkeypatch.setattr(pipeline.subprocess, "Popen", lambda *a, **k: object())

    saved = []
    monkeypatch.setattr(
        pipeline, "save_diagnostics_snapshot",
        lambda diagnostics_dir, frame, attempt, classification: saved.append(
            (diagnostics_dir, frame, attempt, classification)
        ),
    )

    result = pipeline.attempt_recording(
        config, "/replay.rpy", str(tmp_path / "out.mp4"), None, None,
        diagnostics_dir="/diag", attempt=2, log=lambda msg: None,
    )

    assert result["classification"] == "timeout"
    assert saved == [("/diag", "the-last-frame", 2, "timeout")]


def test_attempt_recording_does_not_save_diagnostics_snapshot_on_good_classification(monkeypatch, tmp_path):
    config = make_config()
    monkeypatch.setattr(pipeline, "load_end_template", lambda path: None)
    monkeypatch.setattr(pipeline, "_launch_game", lambda *a, **k: 1234)
    monkeypatch.setattr(pipeline, "_settle_crop_geometry", lambda *a, **k: (0, 0, 640, 480))
    monkeypatch.setattr(pipeline, "build_still_mask", lambda *a, **k: None)
    monkeypatch.setattr(pipeline, "build_end_template_mask", lambda *a, **k: None)
    monkeypatch.setattr(
        pipeline, "_monitor_until_end", lambda *a, **k: (True, "still", False, False, "the-last-frame"),
    )
    monkeypatch.setattr(pipeline, "_stop_and_mux", lambda *a, **k: True)
    monkeypatch.setattr(pipeline, "kill_wine_and_wait", lambda *a, **k: None)
    monkeypatch.setattr(pipeline.subprocess, "Popen", lambda *a, **k: object())

    saved = []
    monkeypatch.setattr(
        pipeline, "save_diagnostics_snapshot",
        lambda *a, **k: saved.append((a, k)),
    )

    result = pipeline.attempt_recording(
        config, "/replay.rpy", str(tmp_path / "out.mp4"), None, None,
        diagnostics_dir="/diag", attempt=1, log=lambda msg: None,
    )

    assert result["classification"] == "good"
    assert saved == []


def test_attempt_recording_logs_template_match_as_the_detection_reason(monkeypatch, tmp_path):
    """`detected_by="template"`の場合、サマリー行に「画面静止検知」ではなく
    テンプレート照合であることを表示すること(touhou-recorder reports/76でth06c対応中に
    発見したバグの回帰防止。修正前は`detected`フラグだけを見て常に「画面静止検知」に
    固定されていた)。"""
    config = make_config()
    monkeypatch.setattr(pipeline, "load_end_template", lambda path: None)
    monkeypatch.setattr(pipeline, "_launch_game", lambda *a, **k: 1234)
    monkeypatch.setattr(pipeline, "_settle_crop_geometry", lambda *a, **k: (0, 0, 640, 480))
    monkeypatch.setattr(pipeline, "build_still_mask", lambda *a, **k: None)
    monkeypatch.setattr(pipeline, "build_end_template_mask", lambda *a, **k: None)
    monkeypatch.setattr(
        pipeline, "_monitor_until_end", lambda *a, **k: (True, "template", False, False, "the-last-frame"),
    )
    monkeypatch.setattr(pipeline, "_stop_and_mux", lambda *a, **k: True)
    monkeypatch.setattr(pipeline, "kill_wine_and_wait", lambda *a, **k: None)
    monkeypatch.setattr(pipeline.subprocess, "Popen", lambda *a, **k: object())

    logs = []
    result = pipeline.attempt_recording(
        config, "/replay.rpy", str(tmp_path / "out.mp4"), None, None,
        diagnostics_dir="/diag", attempt=1, log=logs.append,
    )

    assert result["classification"] == "good"
    assert any("検知方式: リプレイ選択画面テンプレート照合" in line for line in logs)
    assert not any("検知方式: 画面静止検知" in line for line in logs)


def test_record_with_retry_passes_diagnostics_dir_and_increasing_attempt_number(monkeypatch):
    config = make_config()
    attempts_seen = []

    def fake_attempt(*args, **kwargs):
        attempts_seen.append((kwargs.get("diagnostics_dir"), kwargs.get("attempt")))
        if len(attempts_seen) == 1:
            return {"output_exists": False, "classification": "setup_error", "total_record_sec": 5.0}
        return {"output_exists": True, "classification": "good", "total_record_sec": 60.0}

    monkeypatch.setattr(pipeline, "attempt_recording", fake_attempt)
    monkeypatch.setattr(pipeline, "measure_duplicate_rate", lambda *a, **k: 1.0)

    success = pipeline.record_with_retry(
        config, "/replay.rpy", "/out.mp4", max_attempts=3, diagnostics_dir="/diag", log=lambda msg: None,
    )

    assert success is True
    assert attempts_seen == [("/diag", 1), ("/diag", 2)]


def test_record_with_retry_saves_diagnostics_snapshot_on_duplicate_rate_discard(monkeypatch):
    config = make_config()
    monkeypatch.setattr(pipeline, "attempt_recording", lambda *a, **k: {
        "output_exists": True, "classification": "good", "total_record_sec": 60.0,
    })
    monkeypatch.setattr(pipeline, "measure_duplicate_rate", lambda *a, **k: 90.0)
    monkeypatch.setattr(pipeline, "grab_frame_from_video", lambda video_path, at_sec: f"frame:{video_path}:{at_sec}")
    saved = []
    monkeypatch.setattr(
        pipeline, "save_diagnostics_snapshot",
        lambda diagnostics_dir, frame, attempt, classification: saved.append(
            (diagnostics_dir, frame, attempt, classification)
        ),
    )

    success = pipeline.record_with_retry(
        config, "/replay.rpy", "/out.mp4", max_attempts=1, max_duplicate_rate=30.0,
        diagnostics_dir="/diag", log=lambda msg: None,
    )

    assert success is False
    assert saved == [("/diag", "frame:/out.mp4:15", 1, "duplicate_rate")]


def test_record_with_retry_uses_content_end_sec_for_duplicate_rate_window(monkeypatch):
    """重複フレーム率の計測窓の終端は`total_record_sec`ではなく`content_end_sec`を使う。
    短いリプレイでは終了検知の確認待ち(still: 16秒/template: 4秒相当)ぶんの静止画面が
    録画末尾に付加されるため、`total_record_sec`をそのまま使うと固定30秒窓の大半が
    その静止画面になり閾値超過と誤判定する(本番のth06ncジョブで発生、Issue #250)。"""
    config = make_config()
    monkeypatch.setattr(pipeline, "attempt_recording", lambda *a, **k: {
        "output_exists": True, "classification": "good",
        "total_record_sec": 48.3, "content_end_sec": 32.3,
    })
    calls = []
    monkeypatch.setattr(
        pipeline, "measure_duplicate_rate",
        lambda *a, **k: calls.append(a) or 1.0,
    )

    success = pipeline.record_with_retry(config, "/replay.rpy", "/out.mp4", max_attempts=1, log=lambda msg: None)

    assert success is True
    assert calls == [("/out.mp4", 15, pytest.approx(17.3))]


def test_record_with_retry_falls_back_to_total_record_sec_without_content_end_sec(monkeypatch):
    """`content_end_sec`を返さない(旧仕様の)戻り値でも従来どおり`total_record_sec`を
    使えること。"""
    config = make_config()
    monkeypatch.setattr(pipeline, "attempt_recording", lambda *a, **k: {
        "output_exists": True, "classification": "good", "total_record_sec": 60.0,
    })
    calls = []
    monkeypatch.setattr(
        pipeline, "measure_duplicate_rate",
        lambda *a, **k: calls.append(a) or 1.0,
    )

    success = pipeline.record_with_retry(config, "/replay.rpy", "/out.mp4", max_attempts=1, log=lambda msg: None)

    assert success is True
    assert calls == [("/out.mp4", 15, 30)]


def test_attempt_recording_content_end_sec_excludes_still_confirmation_tail(monkeypatch, tmp_path):
    """still検知(画面静止)の場合、確認待ち`STILL_CONSECUTIVE_REQUIRED`(8) *
    `POLL_INTERVAL_SEC`(2秒) = 16秒ぶんを`total_record_sec`から差し引いた
    `content_end_sec`を返すこと(Issue #250)。"""
    config = make_config()
    monkeypatch.setattr(pipeline, "load_end_template", lambda path: None)
    monkeypatch.setattr(pipeline, "_launch_game", lambda *a, **k: 1234)
    monkeypatch.setattr(pipeline, "_settle_crop_geometry", lambda *a, **k: (0, 0, 640, 480))
    monkeypatch.setattr(pipeline, "build_still_mask", lambda *a, **k: None)
    monkeypatch.setattr(pipeline, "build_end_template_mask", lambda *a, **k: None)
    monkeypatch.setattr(
        pipeline, "_monitor_until_end", lambda *a, **k: (True, "still", False, False, "the-last-frame"),
    )
    monkeypatch.setattr(pipeline, "_stop_and_mux", lambda *a, **k: True)
    monkeypatch.setattr(pipeline, "kill_wine_and_wait", lambda *a, **k: None)
    monkeypatch.setattr(pipeline.subprocess, "Popen", lambda *a, **k: object())
    times = iter([100.0, 148.3])
    monkeypatch.setattr(pipeline.time, "time", lambda: next(times))

    result = pipeline.attempt_recording(
        config, "/replay.rpy", str(tmp_path / "out.mp4"), None, None,
        diagnostics_dir="/diag", attempt=1, log=lambda msg: None,
    )

    assert result["total_record_sec"] == pytest.approx(48.3)
    assert result["content_end_sec"] == pytest.approx(48.3 - 16.0)


def test_attempt_recording_content_end_sec_excludes_template_confirmation_tail(monkeypatch, tmp_path):
    """template検知の場合、確認待ち`END_TEMPLATE_CONSECUTIVE_REQUIRED`(2) *
    `POLL_INTERVAL_SEC`(2秒) = 4秒ぶんを差し引くこと(Issue #250)。"""
    config = make_config()
    monkeypatch.setattr(pipeline, "load_end_template", lambda path: object())
    monkeypatch.setattr(pipeline, "_launch_game", lambda *a, **k: 1234)
    monkeypatch.setattr(pipeline, "_settle_crop_geometry", lambda *a, **k: (0, 0, 640, 480))
    monkeypatch.setattr(pipeline, "build_still_mask", lambda *a, **k: None)
    monkeypatch.setattr(pipeline, "build_end_template_mask", lambda *a, **k: None)
    monkeypatch.setattr(
        pipeline, "_monitor_until_end", lambda *a, **k: (True, "template", False, False, "the-last-frame"),
    )
    monkeypatch.setattr(pipeline, "_stop_and_mux", lambda *a, **k: True)
    monkeypatch.setattr(pipeline, "kill_wine_and_wait", lambda *a, **k: None)
    monkeypatch.setattr(pipeline.subprocess, "Popen", lambda *a, **k: object())
    times = iter([100.0, 120.0])
    monkeypatch.setattr(pipeline.time, "time", lambda: next(times))

    result = pipeline.attempt_recording(
        config, "/replay.rpy", str(tmp_path / "out.mp4"), None, None,
        diagnostics_dir="/diag", attempt=1, log=lambda msg: None,
    )

    assert result["total_record_sec"] == pytest.approx(20.0)
    assert result["content_end_sec"] == pytest.approx(20.0 - 4.0)


def test_attempt_recording_content_end_sec_equals_total_record_sec_on_timeout(monkeypatch, tmp_path):
    """timeout/frozen(detected_byがNone)の場合は差し引く確認待ちが無いため、
    `content_end_sec`は`total_record_sec`のままであること。"""
    config = make_config()
    monkeypatch.setattr(pipeline, "load_end_template", lambda path: None)
    monkeypatch.setattr(pipeline, "_launch_game", lambda *a, **k: 1234)
    monkeypatch.setattr(pipeline, "_settle_crop_geometry", lambda *a, **k: (0, 0, 640, 480))
    monkeypatch.setattr(pipeline, "build_still_mask", lambda *a, **k: None)
    monkeypatch.setattr(pipeline, "build_end_template_mask", lambda *a, **k: None)
    monkeypatch.setattr(
        pipeline, "_monitor_until_end", lambda *a, **k: (False, None, True, False, "the-last-frame"),
    )
    monkeypatch.setattr(pipeline, "_stop_and_mux", lambda *a, **k: True)
    monkeypatch.setattr(pipeline, "kill_wine_and_wait", lambda *a, **k: None)
    monkeypatch.setattr(pipeline, "save_diagnostics_snapshot", lambda *a, **k: None)
    monkeypatch.setattr(pipeline.subprocess, "Popen", lambda *a, **k: object())
    times = iter([100.0, 160.0])
    monkeypatch.setattr(pipeline.time, "time", lambda: next(times))

    result = pipeline.attempt_recording(
        config, "/replay.rpy", str(tmp_path / "out.mp4"), None, None,
        diagnostics_dir="/diag", attempt=1, log=lambda msg: None,
    )

    assert result["content_end_sec"] == result["total_record_sec"] == pytest.approx(60.0)
