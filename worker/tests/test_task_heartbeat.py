"""TaskHeartbeat(Step Functionsへの死活通知、Issue #49)のテスト。"""
import threading
import time

import pytest

from task_heartbeat import TaskHeartbeat


class FakeSfn:
    def __init__(self, error=None):
        self.calls = []
        self._error = error
        self.called = threading.Event()

    def send_task_heartbeat(self, taskToken):  # noqa: N803 - boto3のAPIに合わせる
        self.calls.append(taskToken)
        self.called.set()
        if self._error is not None:
            raise self._error


class TaskTimedOut(Exception):
    """boto3が動的生成する例外の名前だけを模したもの(型名で判定しているため)。"""


def _wait_for(predicate, timeout=2.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return False


def test_送信を繰り返す():
    client = FakeSfn()
    heartbeat = TaskHeartbeat("token-1", log=lambda _msg: None, interval_sec=0.01, client=client)
    heartbeat.start()
    try:
        assert _wait_for(lambda: len(client.calls) >= 2)
    finally:
        heartbeat.stop()
    assert client.calls[0] == "token-1"


def test_taskToken無しでは何も送らない():
    client = FakeSfn()
    heartbeat = TaskHeartbeat(None, log=lambda _msg: None, interval_sec=0.01, client=client)
    heartbeat.start()
    time.sleep(0.05)
    heartbeat.stop()
    assert client.calls == []


def test_一時的な失敗では停止しない():
    client = FakeSfn(error=RuntimeError("throttled"))
    logs = []
    heartbeat = TaskHeartbeat("token-1", log=logs.append, interval_sec=0.01, client=client)
    heartbeat.start()
    try:
        assert _wait_for(lambda: len(client.calls) >= 2)
    finally:
        heartbeat.stop()


def test_taskTokenが無効になったら送信を止める():
    client = FakeSfn(error=TaskTimedOut("expired"))
    logs = []
    heartbeat = TaskHeartbeat("token-1", log=logs.append, interval_sec=0.01, client=client)
    heartbeat.start()
    assert _wait_for(lambda: len(client.calls) >= 1)
    # 停止した後は呼び出し回数が増えない。
    time.sleep(0.05)
    heartbeat.stop()
    assert len(client.calls) == 1
    assert any("無効になった" in message for message in logs)


@pytest.mark.parametrize("token", ["", None])
def test_偽値のtaskTokenはスレッドを起動しない(token):
    client = FakeSfn()
    heartbeat = TaskHeartbeat(token, log=lambda _msg: None, interval_sec=0.01, client=client)
    heartbeat.start()
    heartbeat.stop()
    assert client.calls == []
