"""ワーカーコンテナ実行(runner)のテスト。"""
import base64

import pytest

from runner import (
    ContainerRun,
    ImagePreparationError,
    build_docker_command,
    container_name,
    ecr_login,
    pull_image,
    redact_command,
)
from helpers import make_config


class FakeResult:
    def __init__(self, returncode=0, stderr=""):
        self.returncode = returncode
        self.stderr = stderr
        self.stdout = ""


def test_環境変数をそのままdocker_runへ渡す():
    config = make_config(docker_cpus="4", docker_extra_args=("--shm-size=1g",))
    cmd = build_docker_command(config, "job-1", {"JOB_ID": "job-1", "GAME": "th07"})

    assert cmd[:5] == ["docker", "run", "--rm", "--name", container_name("job-1")]
    assert "--cpus" in cmd and "4" in cmd
    assert "--shm-size=1g" in cmd
    assert "-e" in cmd and "JOB_ID=job-1" in cmd and "GAME=th07" in cmd
    assert cmd[-1] == config.worker_image


def test_ログ用のコマンドはtaskTokenと認証情報を伏せる():
    config = make_config()
    cmd = build_docker_command(
        config, "job-1", {"TASK_TOKEN": "secret", "AWS_SECRET_ACCESS_KEY": "key", "GAME": "th07"}
    )

    redacted = redact_command(cmd)

    assert "TASK_TOKEN=***" in redacted
    assert "AWS_SECRET_ACCESS_KEY=***" in redacted
    assert "GAME=th07" in redacted
    assert "TASK_TOKEN=secret" not in redacted


class FakeEcr:
    def get_authorization_token(self):
        token = base64.b64encode(b"AWS:password").decode()
        return {"authorizationData": [{"authorizationToken": token}]}


def test_ECRログインはトークンを標準入力で渡す():
    calls = []

    def run(cmd, **kwargs):
        calls.append((cmd, kwargs))
        return FakeResult()

    ecr_login(FakeEcr(), "registry.example/sattori-worker:latest", log=lambda _m: None, run=run)

    cmd, kwargs = calls[0]
    assert cmd[:4] == ["docker", "login", "--username", "AWS"]
    assert cmd[-1] == "registry.example"
    assert kwargs["input"] == "password"


def test_ECRログイン失敗はImagePreparationError():
    def run(cmd, **kwargs):
        return FakeResult(returncode=1, stderr="denied")

    with pytest.raises(ImagePreparationError):
        ecr_login(FakeEcr(), "registry.example/img:latest", log=lambda _m: None, run=run)


def test_pullは数回まで再試行してから諦める():
    attempts = []

    def run(cmd, **kwargs):
        attempts.append(cmd)
        return FakeResult(returncode=1, stderr="timeout")

    with pytest.raises(ImagePreparationError):
        pull_image("registry.example/img:latest", log=lambda _m: None, run=run)
    assert len(attempts) == 3


def test_pullが成功すれば再試行しない():
    attempts = []

    def run(cmd, **kwargs):
        attempts.append(cmd)
        return FakeResult()

    pull_image("registry.example/img:latest", log=lambda _m: None, run=run)
    assert len(attempts) == 1


def test_コンテナ出力を1行ずつ渡し終了コードを返す():
    class FakeProcess:
        def __init__(self):
            self.stdout = iter(["録画開始\n", "録画完了\n"])

        def wait(self):
            return 0

    lines = []
    container = ContainerRun(
        make_config(),
        "job-1",
        {"JOB_ID": "job-1"},
        log=lambda _m: None,
        popen=lambda *args, **kwargs: FakeProcess(),
    )

    assert container.run(lines.append) == 0
    assert lines == ["録画開始", "録画完了"]
    assert container.killed is False


def test_killはdocker_killを発行する():
    calls = []
    container = ContainerRun(
        make_config(),
        "job-1",
        {},
        log=lambda _m: None,
        run=lambda cmd, **kwargs: calls.append(cmd) or FakeResult(),
    )

    container.kill()

    assert container.killed is True
    assert calls[0] == ["docker", "kill", container_name("job-1")]
