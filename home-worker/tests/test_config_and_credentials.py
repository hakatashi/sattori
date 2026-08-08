"""設定読み込みと認証情報供給のテスト。"""
import datetime

import pytest

from config import ConfigError, load_config
from credentials import MIN_CONTAINER_TTL_SEC, CredentialProvider

REQUIRED_ENV = {
    "JOBS_TABLE": "sattori-jobs",
    "WORKERS_TABLE": "sattori-workers",
    "WORKER_IMAGE": "registry.example/sattori-worker:latest",
}


def set_env(monkeypatch, **extra):
    for key, value in {**REQUIRED_ENV, **extra}.items():
        monkeypatch.setenv(key, value)


def test_必須の環境変数が無ければエラー(monkeypatch):
    monkeypatch.delenv("JOBS_TABLE", raising=False)
    monkeypatch.setenv("WORKERS_TABLE", "w")
    monkeypatch.setenv("WORKER_IMAGE", "i")
    with pytest.raises(ConfigError):
        load_config()


def test_既定値は録画対応タイトルと控えめな並列度(monkeypatch):
    set_env(monkeypatch)
    config = load_config()
    assert config.supported_games == ("th06", "th07", "th08", "th11")
    assert config.max_concurrency == 2
    assert config.capabilities == ()


def test_能力とタイトルはカンマ区切りで上書きできる(monkeypatch):
    set_env(
        monkeypatch,
        HOME_WORKER_SUPPORTED_GAMES="th07, th08",
        HOME_WORKER_CAPABILITIES="slow-motion-recording",
        HOME_WORKER_MAX_CONCURRENCY="4",
    )
    config = load_config()
    assert config.supported_games == ("th07", "th08")
    assert config.capabilities == ("slow-motion-recording",)
    assert config.max_concurrency == 4


def test_docker追加引数はシェルと同じ規則で分割する(monkeypatch):
    set_env(monkeypatch, HOME_WORKER_DOCKER_ARGS="--shm-size=1g --memory 8g")
    assert load_config().docker_extra_args == ("--shm-size=1g", "--memory", "8g")


class FakeSts:
    def __init__(self, expires_in_sec):
        self.calls = []
        self._expires_in_sec = expires_in_sec

    def assume_role(self, **kwargs):
        self.calls.append(kwargs)
        return {
            "Credentials": {
                "AccessKeyId": "AKIA",
                "SecretAccessKey": "secret",
                "SessionToken": "token",
                "Expiration": datetime.datetime.now(datetime.timezone.utc)
                + datetime.timedelta(seconds=self._expires_in_sec),
            }
        }


def test_コンテナへ渡す認証情報は環境変数の形で返す():
    sts = FakeSts(expires_in_sec=4 * 60 * 60)
    provider = CredentialProvider(
        "eu-south-2", role_arn="arn:aws:iam::1:role/home", log=lambda _m: None, sts_client=sts
    )

    env = provider.container_env()

    assert env["AWS_ACCESS_KEY_ID"] == "AKIA"
    assert env["AWS_SESSION_TOKEN"] == "token"
    assert len(sts.calls) == 1


def test_残存時間がジョブ1本に足りなければassumeし直す():
    # 期限切れ間近の認証情報をコンテナへ渡すと、録画の途中で認証エラーになり
    # そのジョブが丸ごと無駄になる。
    sts = FakeSts(expires_in_sec=MIN_CONTAINER_TTL_SEC - 60)
    provider = CredentialProvider(
        "eu-south-2", role_arn="arn:aws:iam::1:role/home", log=lambda _m: None, sts_client=sts
    )

    provider.container_env()
    provider.container_env()

    assert len(sts.calls) == 2


def test_十分な残存時間があれば再assumeしない():
    sts = FakeSts(expires_in_sec=MIN_CONTAINER_TTL_SEC + 3600)
    provider = CredentialProvider(
        "eu-south-2", role_arn="arn:aws:iam::1:role/home", log=lambda _m: None, sts_client=sts
    )

    provider.container_env()
    provider.container_env()

    assert len(sts.calls) == 1
