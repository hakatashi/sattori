"""余力判定(capacity)とハートビート(heartbeat)のテスト。"""
import datetime

from capacity import can_accept, load_per_cpu
from heartbeat import TTL_SEC, build_heartbeat
from helpers import make_config


def test_ロードアベレージはコア数で割る():
    assert load_per_cpu(getloadavg=lambda: (4.0, 0, 0), cpu_count=lambda: 8) == 0.5


def test_ロードアベレージを取得できない環境では0扱い():
    def raises():
        raise OSError("unsupported")

    assert load_per_cpu(getloadavg=raises, cpu_count=lambda: 8) == 0.0


def test_空きがあり負荷も低ければ受け付ける():
    assert can_accept(make_config(), active_jobs=0, load=0.1) is True


def test_同時実行の上限に達していれば受け付けない():
    assert can_accept(make_config(max_concurrency=2), active_jobs=2, load=0.0) is False


def test_負荷が高ければ空きがあっても受け付けない():
    # 実行中ジョブを止める判断ではない（新規claimだけを止める、Issue #49 論点4）。
    assert can_accept(make_config(), active_jobs=0, load=0.9) is False


def test_ハートビートはAWS側の判定に必要な項目を揃える():
    now = datetime.datetime(2026, 8, 9, 12, 0, tzinfo=datetime.timezone.utc)
    item = build_heartbeat(
        make_config(capabilities=("slow-motion-recording",)),
        accepting=True,
        active_jobs=1,
        now=now,
    )

    assert item == {
        "workerId": "home-1",
        "kind": "home",
        "lastHeartbeatAt": now.isoformat(),
        "accepting": True,
        "activeJobs": 1,
        "maxConcurrency": 2,
        "supportedGames": ["th06", "th07"],
        "capabilities": ["slow-motion-recording"],
        "ttl": int(now.timestamp()) + TTL_SEC,
    }
