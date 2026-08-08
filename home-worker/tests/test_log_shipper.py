"""CloudWatch Logsへのログ転送のテスト。"""
from log_shipper import MAX_BATCH_SIZE, CloudWatchLogShipper


class FakeLogs:
    def __init__(self, put_error=None, create_error=None):
        self.created = []
        self.batches = []
        self._put_error = put_error
        self._create_error = create_error

    def create_log_stream(self, logGroupName, logStreamName):  # noqa: N803 - boto3のAPI
        self.created.append((logGroupName, logStreamName))
        if self._create_error is not None:
            raise self._create_error

    def put_log_events(self, logGroupName, logStreamName, logEvents):  # noqa: N803
        self.batches.append(logEvents)
        if self._put_error is not None:
            raise self._put_error


class ResourceAlreadyExistsException(Exception):
    """boto3が動的生成する例外の名前だけを模したもの(型名で判定しているため)。"""


def make_shipper(client, now=None):
    clock = iter(now) if now else None
    return CloudWatchLogShipper(
        client,
        "/sattori/worker",
        "job-1",
        log=lambda _m: None,
        now=(lambda: next(clock)) if clock else (lambda: 0.0),
    )


def test_EC2ワーカーと同じストリーム名へ書く():
    client = FakeLogs()
    shipper = make_shipper(client)

    shipper.append("録画開始")
    shipper.flush()

    assert client.created == [("/sattori/worker", "job-1")]
    assert client.batches[0][0]["message"] == "録画開始"


def test_既存ストリームでも失敗しない():
    client = FakeLogs(create_error=ResourceAlreadyExistsException("exists"))
    shipper = make_shipper(client)

    shipper.append("行")
    shipper.flush()

    assert len(client.batches) == 1


def test_バッチ上限に達したら自動でflushする():
    client = FakeLogs()
    shipper = make_shipper(client)

    for index in range(MAX_BATCH_SIZE):
        shipper.append(f"line-{index}")

    assert len(client.batches) == 1
    assert len(client.batches[0]) == MAX_BATCH_SIZE


def test_転送に失敗したら以降は諦めて録画を止めない():
    client = FakeLogs(put_error=RuntimeError("throttled"))
    shipper = make_shipper(client)

    shipper.append("行1")
    shipper.flush()
    shipper.append("行2")
    shipper.flush()

    # 1回失敗した時点で無効化され、以降はAPIを叩かない。
    assert len(client.batches) == 1


def test_バッファが空ならAPIを叩かない():
    client = FakeLogs()
    shipper = make_shipper(client)

    shipper.flush()

    assert client.batches == []
