"""1回の録画試行と、その自動リトライ。"""

import json
import subprocess

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
