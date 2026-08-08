"""デーモンのループ・claim取り消し検知のテスト。

AWS呼び出しはすべて差し替え、`docker` も起動しない。ここで守りたいのは
「対応外タイトルを取らない」「空きを超えて取らない」「claimが取り消されたら
必ずコンテナを止める(＝二重録画を起こさない)」という判断のほうである。
"""
import threading

from botocore.exceptions import ClientError

import daemon as daemon_module
from daemon import HomeWorkerDaemon
from helpers import make_config


class FakeJobsTable:
    def __init__(self, offers=None, claimable=True):
        self.offers = offers or []
        self.claimable = claimable
        self.claimed = []
        self.touch_results = []

    def query(self, **_kwargs):
        return {"Items": self.offers}

    def update_item(self, **kwargs):
        expression = kwargs["UpdateExpression"]
        if "assignedWorkerId = :w" in expression:
            if not self.claimable:
                raise ClientError(
                    {"Error": {"Code": "ConditionalCheckFailedException"}}, "UpdateItem"
                )
            self.claimed.append(kwargs["Key"]["jobId"])
            return {"Attributes": {"jobId": kwargs["Key"]["jobId"], "homeWorkerEnv": {}}}
        return {}


class FakeWorkersTable:
    def __init__(self):
        self.items = []

    def put_item(self, Item):  # noqa: N803 - boto3のAPIに合わせる
        self.items.append(Item)


def make_daemon(config=None, jobs_table=None, workers_table=None):
    daemon = HomeWorkerDaemon(config or make_config(), credentials=object(), log=lambda _m: None)
    daemon._jobs_table = lambda: jobs_table or FakeJobsTable()  # noqa: SLF001
    daemon._workers_table = lambda: workers_table or FakeWorkersTable()  # noqa: SLF001
    return daemon


def test_対応していないタイトルのオファーはclaimしない():
    jobs = FakeJobsTable(offers=[{"jobId": "job-1", "game": "th11"}])
    daemon = make_daemon(config=make_config(supported_games=("th07",)), jobs_table=jobs)
    daemon._start_job = lambda job: None  # noqa: SLF001

    daemon._claim_offers(available_slots=2)  # noqa: SLF001

    assert jobs.claimed == []


def test_空きスロットの数までしかclaimしない():
    jobs = FakeJobsTable(
        offers=[{"jobId": "job-1", "game": "th07"}, {"jobId": "job-2", "game": "th07"}]
    )
    daemon = make_daemon(jobs_table=jobs)
    daemon._start_job = lambda job: None  # noqa: SLF001

    daemon._claim_offers(available_slots=1)  # noqa: SLF001

    assert jobs.claimed == ["job-1"]


def test_他ワーカーに先を越されても次のオファーへ進む():
    jobs = FakeJobsTable(offers=[{"jobId": "job-1", "game": "th07"}], claimable=False)
    daemon = make_daemon(jobs_table=jobs)
    started = []
    daemon._start_job = started.append  # noqa: SLF001

    daemon._claim_offers(available_slots=2)  # noqa: SLF001

    assert started == []


def test_ハートビートは間隔を空けて書く():
    workers = FakeWorkersTable()
    daemon = make_daemon(workers_table=workers)

    daemon._publish_heartbeat(accepting=True, active_jobs=0)  # noqa: SLF001
    daemon._publish_heartbeat(accepting=True, active_jobs=0)  # noqa: SLF001

    assert len(workers.items) == 1
    assert workers.items[0]["accepting"] is True


class FakeContainer:
    def __init__(self):
        self.killed = False

    def kill(self):
        self.killed = True


def test_claimが取り消されたらコンテナを止める(monkeypatch):
    monkeypatch.setattr(daemon_module, "CLAIM_CHECK_INTERVAL_SEC", 0.01)
    monkeypatch.setattr(daemon_module.claim_module, "touch_claim", lambda *_args: False)
    container = FakeContainer()
    daemon = make_daemon()
    daemon._running["job-1"] = container  # noqa: SLF001

    thread = threading.Thread(target=daemon._watch_claim, args=(object(), "job-1", container))
    thread.start()
    thread.join(timeout=2.0)

    assert container.killed is True


def test_claim確認の一時的な失敗ではコンテナを止めない(monkeypatch):
    monkeypatch.setattr(daemon_module, "CLAIM_CHECK_INTERVAL_SEC", 0.01)
    calls = []

    def flaky(*_args):
        calls.append(1)
        if len(calls) == 1:
            raise ClientError({"Error": {"Code": "ThrottlingException"}}, "UpdateItem")
        return False

    monkeypatch.setattr(daemon_module.claim_module, "touch_claim", flaky)
    container = FakeContainer()
    daemon = make_daemon()
    daemon._running["job-1"] = container  # noqa: SLF001

    thread = threading.Thread(target=daemon._watch_claim, args=(object(), "job-1", container))
    thread.start()
    thread.join(timeout=2.0)

    # 1回目は握りつぶして継続し、2回目の「取り消し済み」で初めて停止する。
    assert len(calls) >= 2
    assert container.killed is True
