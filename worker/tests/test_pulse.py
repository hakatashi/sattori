import os

import pytest

import pulse


class FakeCompletedProcess:
    def __init__(self, returncode=0, stdout="", stderr=""):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


def fake_pactl(monkeypatch, responses):
    """pactl呼び出しを差し替える。responses は (引数リストの先頭要素 -> 応答) の辞書。"""
    calls = []

    def run(cmd, **kwargs):
        assert cmd[0] == "pactl"
        calls.append(cmd)
        return responses.get(cmd[1], FakeCompletedProcess())

    monkeypatch.setattr(pulse.subprocess, "run", run)
    return calls


MODULES_OUTPUT = "\n".join([
    "12\tmodule-device-restore\t",
    "23\tmodule-null-sink\tsink_name=sattori_job_abc sink_properties=device.description=sattori_job_abc",
    "24\tmodule-null-sink\tsink_name=sattori_job_abc_other",
    "25\tmodule-always-sink\t",
])


def test_sink_name_for_job_normalizes_unsafe_characters():
    # jobIdはUUID(ハイフン入り)。PulseAudioのsink名として安全な文字種に正規化する。
    name = pulse.sink_name_for_job("64367b3c-64f5-47c4-be9d-e0c4aa8a35d8")

    assert name == "sattori_job_64367b3c_64f5_47c4_be9d_e0c4aa8a35d8"


def test_sink_name_for_job_truncates_long_ids():
    name = pulse.sink_name_for_job("x" * 200)

    assert len(name) == pulse.MAX_SINK_NAME_LENGTH
    assert name.startswith(pulse.SINK_NAME_PREFIX)


def test_local_sink_name_includes_pid():
    # ローカルで複数の録画スクリプトを手動並列実行しても衝突しないこと。
    assert pulse.local_sink_name() == f"{pulse.SINK_NAME_PREFIX}local_{os.getpid()}"


def test_find_null_sink_modules_matches_only_exact_sink_name(monkeypatch):
    fake_pactl(monkeypatch, {"list": FakeCompletedProcess(stdout=MODULES_OUTPUT)})

    # 前方一致(sattori_job_abc_other)や他種のモジュールを拾わないこと。
    assert pulse.find_null_sink_modules("sattori_job_abc") == ["23"]
    assert pulse.find_null_sink_modules("sattori_job_abc_other") == ["24"]
    assert pulse.find_null_sink_modules("sattori_job_zzz") == []


def test_find_null_sink_modules_returns_empty_when_pactl_fails(monkeypatch):
    fake_pactl(monkeypatch, {"list": FakeCompletedProcess(returncode=1, stderr="connection refused")})

    assert pulse.find_null_sink_modules("sattori_job_abc") == []


def test_create_null_sink_unloads_stale_same_name_sink_first(monkeypatch):
    # 同名sinkが残っていると新しいsinkが`<名前>.2`にリネームされ、`<名前>.monitor`が
    # 前回の孤児sinkを指してしまうため、作成前に必ず掃除する。
    calls = fake_pactl(monkeypatch, {
        "list": FakeCompletedProcess(stdout=MODULES_OUTPUT),
        "load-module": FakeCompletedProcess(stdout="31\n"),
    })

    module_id = pulse.create_null_sink("sattori_job_abc", log=lambda msg: None)

    assert module_id == "31"
    assert ["pactl", "unload-module", "23"] in calls
    assert calls[-1][:3] == ["pactl", "load-module", "module-null-sink"]
    assert "sink_name=sattori_job_abc" in calls[-1]


def test_create_null_sink_raises_when_load_module_fails(monkeypatch):
    fake_pactl(monkeypatch, {
        "list": FakeCompletedProcess(stdout=""),
        "load-module": FakeCompletedProcess(returncode=1, stderr="Failure: Module initialization failed"),
    })

    with pytest.raises(RuntimeError, match="sattori_job_abc"):
        pulse.create_null_sink("sattori_job_abc", log=lambda msg: None)


def test_job_sink_unloads_module_on_exit(monkeypatch):
    calls = fake_pactl(monkeypatch, {
        "list": FakeCompletedProcess(stdout=""),
        "load-module": FakeCompletedProcess(stdout="31\n"),
    })

    with pulse.job_sink("sattori_job_abc", log=lambda msg: None) as sink_name:
        assert sink_name == "sattori_job_abc"

    assert calls[-1] == ["pactl", "unload-module", "31"]


def test_job_sink_unloads_module_even_when_body_raises(monkeypatch):
    # 録画が失敗してもsinkを残さない(孤児sinkが次のジョブのリネームを誘発するため)。
    calls = fake_pactl(monkeypatch, {
        "list": FakeCompletedProcess(stdout=""),
        "load-module": FakeCompletedProcess(stdout="31\n"),
    })

    with pytest.raises(RuntimeError, match="録画失敗"):
        with pulse.job_sink("sattori_job_abc", log=lambda msg: None):
            raise RuntimeError("録画失敗")

    assert calls[-1] == ["pactl", "unload-module", "31"]


def test_unload_module_returns_false_on_failure(monkeypatch):
    fake_pactl(monkeypatch, {"unload-module": FakeCompletedProcess(returncode=1, stderr="No such module")})
    messages = []

    assert pulse.unload_module("31", log=messages.append) is False
    assert any("unload" in msg for msg in messages)
