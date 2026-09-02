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
        "output_exists": True, "classification": "good", "fps_runaway_hz": None, "total_record_sec": 60.0,
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
        "output_exists": True, "classification": "timeout", "fps_runaway_hz": None, "total_record_sec": 60.0,
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
        "output_exists": True, "classification": "good", "fps_runaway_hz": None, "total_record_sec": 60.0,
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
        "output_exists": True, "classification": "timeout", "fps_runaway_hz": None, "total_record_sec": 60.0,
    })
    monkeypatch.setattr(pipeline, "measure_duplicate_rate", lambda *a, **k: 1.0)
    monkeypatch.setattr(pipeline, "check_replay_desync", lambda *a, **k: None)
    logs = []

    pipeline.record_with_retry(config, "/replay.rpy", "/out.mp4", max_attempts=1, log=logs.append)

    assert any("WARNING" in msg and "タイムアウト" in msg for msg in logs)


def test_record_with_retry_gives_up_after_max_attempts(monkeypatch):
    config = make_config()
    monkeypatch.setattr(pipeline, "attempt_recording", lambda *a, **k: {
        "output_exists": False, "classification": "setup_error", "fps_runaway_hz": None, "total_record_sec": 0.0,
    })

    success = pipeline.record_with_retry(config, "/replay.rpy", "/out.mp4", max_attempts=2, log=lambda msg: None)

    assert success is False


def test_record_with_retry_retries_on_fps_runaway_then_succeeds(monkeypatch):
    config = make_config()
    calls = []

    def fake_attempt(*args, **kwargs):
        calls.append(1)
        if len(calls) == 1:
            return {"output_exists": True, "classification": "fps_runaway", "fps_runaway_hz": 900.0, "total_record_sec": 5.0}
        return {"output_exists": True, "classification": "good", "fps_runaway_hz": None, "total_record_sec": 60.0}

    monkeypatch.setattr(pipeline, "attempt_recording", fake_attempt)
    monkeypatch.setattr(pipeline, "measure_duplicate_rate", lambda *a, **k: 1.0)

    success = pipeline.record_with_retry(config, "/replay.rpy", "/out.mp4", max_attempts=3, log=lambda msg: None)

    assert success is True
    assert len(calls) == 2


def test_record_with_retry_discards_output_above_max_duplicate_rate(monkeypatch):
    config = make_config()
    monkeypatch.setattr(pipeline, "attempt_recording", lambda *a, **k: {
        "output_exists": True, "classification": "good", "fps_runaway_hz": None, "total_record_sec": 60.0,
    })
    monkeypatch.setattr(pipeline, "measure_duplicate_rate", lambda *a, **k: 90.0)

    success = pipeline.record_with_retry(
        config, "/replay.rpy", "/out.mp4", max_attempts=1, max_duplicate_rate=30.0, log=lambda msg: None
    )

    assert success is False


def test_record_with_retry_creates_and_destroys_job_sink(monkeypatch, fake_job_sink):
    # ジョブ専用sinkは録画開始時に作成し、終了時に必ず破棄する(Issue #48)。
    config = make_config(pulse_sink="sattori_job_abc")
    monkeypatch.setattr(pipeline, "attempt_recording", lambda *a, **k: {
        "output_exists": True, "classification": "good", "fps_runaway_hz": None, "total_record_sec": 60.0,
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
        "output_exists": False, "classification": "setup_error", "fps_runaway_hz": None, "total_record_sec": 0.0,
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
            return {"output_exists": True, "classification": "fps_runaway", "fps_runaway_hz": 500.0, "total_record_sec": 5.0}
        return {"output_exists": True, "classification": "good", "fps_runaway_hz": None, "total_record_sec": 60.0}

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
        return {"output_exists": True, "classification": "good", "fps_runaway_hz": None, "total_record_sec": 60.0}

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


def test_monitor_until_end_returns_last_captured_frame_on_fps_runaway(monkeypatch):
    """fps暴走を検知して打ち切られても、直近にgrab_frame()で取得したカラー画像を
    返すこと(Issue #159。診断スナップショットの元になる)。打ち切りが確定した瞬間には
    新しいフレームを取得しないため、"最後に取得できていたフレーム"が使われる。"""
    config = make_config()
    env = config.build_env()
    clock = _FakeClock()
    monkeypatch.setattr(pipeline.time, "time", clock.time)
    monkeypatch.setattr(pipeline.time, "sleep", clock.sleep)
    monkeypatch.setattr(pipeline, "wait_for_log_marker", lambda *a, **k: 0.0)

    gray = np.zeros((120, 160), dtype=np.float32)
    frames = [(gray, "color0"), (gray, "color1")]
    grab_calls = {"n": 0}

    def fake_grab_frame(*a, **k):
        frame = frames[grab_calls["n"]]
        grab_calls["n"] += 1
        return frame

    def fake_scan_fps_runaway(log_path):
        return 900.0 if grab_calls["n"] >= 2 else None

    monkeypatch.setattr(pipeline, "grab_frame", fake_grab_frame)
    monkeypatch.setattr(pipeline, "scan_fps_runaway", fake_scan_fps_runaway)

    detection = pipeline._EndDetection(
        template=None, template_mask=None, template_mad_threshold=0.0, still_mask=None,
    )
    detected, frozen, fps_runaway_hz, last_color_frame = pipeline._monitor_until_end(
        config, env, (0, 0, 640, 480), detection, time_scale=1.0,
        progress_dir=None, expected_duration_seconds=None, seen_lines=set(), log=lambda msg: None,
    )

    assert detected is False
    assert frozen is False
    assert fps_runaway_hz == 900.0
    assert last_color_frame == "color1"


def test_attempt_recording_saves_diagnostics_snapshot_on_discarded_attempt(monkeypatch, tmp_path):
    config = make_config()
    monkeypatch.setattr(pipeline, "load_end_template", lambda path: None)
    monkeypatch.setattr(pipeline, "_launch_game", lambda *a, **k: 1234)
    monkeypatch.setattr(pipeline, "_settle_crop_geometry", lambda *a, **k: (0, 0, 640, 480))
    monkeypatch.setattr(pipeline, "build_still_mask", lambda *a, **k: None)
    monkeypatch.setattr(pipeline, "build_end_template_mask", lambda *a, **k: None)
    monkeypatch.setattr(
        pipeline, "_monitor_until_end", lambda *a, **k: (False, False, 900.0, "the-last-frame"),
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

    assert result["classification"] == "fps_runaway"
    assert saved == [("/diag", "the-last-frame", 2, "fps_runaway")]


def test_attempt_recording_does_not_save_diagnostics_snapshot_on_good_classification(monkeypatch, tmp_path):
    config = make_config()
    monkeypatch.setattr(pipeline, "load_end_template", lambda path: None)
    monkeypatch.setattr(pipeline, "_launch_game", lambda *a, **k: 1234)
    monkeypatch.setattr(pipeline, "_settle_crop_geometry", lambda *a, **k: (0, 0, 640, 480))
    monkeypatch.setattr(pipeline, "build_still_mask", lambda *a, **k: None)
    monkeypatch.setattr(pipeline, "build_end_template_mask", lambda *a, **k: None)
    monkeypatch.setattr(
        pipeline, "_monitor_until_end", lambda *a, **k: (True, False, None, "the-last-frame"),
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


def test_record_with_retry_passes_diagnostics_dir_and_increasing_attempt_number(monkeypatch):
    config = make_config()
    attempts_seen = []

    def fake_attempt(*args, **kwargs):
        attempts_seen.append((kwargs.get("diagnostics_dir"), kwargs.get("attempt")))
        if len(attempts_seen) == 1:
            return {"output_exists": True, "classification": "fps_runaway", "fps_runaway_hz": 500.0, "total_record_sec": 5.0}
        return {"output_exists": True, "classification": "good", "fps_runaway_hz": None, "total_record_sec": 60.0}

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
        "output_exists": True, "classification": "good", "fps_runaway_hz": None, "total_record_sec": 60.0,
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
