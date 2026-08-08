"""`WorkersTable` へのハートビート送出(Issue #49)。

AWS側(`apps/api/src/handlers/sfn/launch.ts`)は、ここに書かれた情報だけを見て
「このジョブを自宅ワーカーへオファーする価値があるか」を判断する。**新鮮な
ハートビートが無ければオファー自体が行われない**ので、デーモンが落ちている
平常時に録画開始が遅れることはない。

項目の意味は `packages/shared/src/worker.ts` の `WorkerHeartbeat` を参照
(型定義が契約の本体で、こちらはその書き手)。
"""
import datetime

#: `WORKER_HEARTBEAT_INTERVAL_SECONDS`(packages/shared/src/worker.ts)と揃えること。
#: AWS側は最終ハートビートから3倍(45秒)以内を「新鮮」とみなす。
INTERVAL_SEC = 15

#: DynamoDB TTL。鮮度判定より十分長くし、止まったデーモンの行を放置しない。
TTL_SEC = 15 * 60


def _now():
    return datetime.datetime.now(datetime.timezone.utc)


def build_heartbeat(config, *, accepting, active_jobs, now=None):
    now = now or _now()
    return {
        "workerId": config.worker_id,
        "kind": "home",
        "lastHeartbeatAt": now.isoformat(),
        "accepting": accepting,
        "activeJobs": active_jobs,
        "maxConcurrency": config.max_concurrency,
        "supportedGames": list(config.supported_games),
        "capabilities": list(config.capabilities),
        "ttl": int(now.timestamp()) + TTL_SEC,
    }


def publish(table, config, *, accepting, active_jobs, now=None):
    """ハートビートを丸ごと上書きする(部分更新にしない)。

    項目が増減してもレコードに古い値が残らないほうが安全で、1台ぶんの小さな
    アイテムなので `PutItem` のコストも無視できる。
    """
    item = build_heartbeat(config, accepting=accepting, active_jobs=active_jobs, now=now)
    table.put_item(Item=item)
    return item
