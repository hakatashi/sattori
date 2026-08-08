"""自宅ワーカー常駐デーモン(Issue #49)の設定。すべて環境変数で与える。

`cdk deploy` の CfnOutput(`JobsTableName`/`WorkersTableName`/`WorkerRepoUri`/
`HomeWorkerRoleArn` 等)をそのまま流し込めばよい。値の意味と既定値の根拠は
各フィールドのコメントを参照。
"""
import os
import shlex
from dataclasses import dataclass, field

# 録画対応タイトル。`packages/shared/src/games.ts` の `SUPPORTED_GAME_IDS` と
# 同じ値を既定にする(TypeScript から自動で取り込む仕組みは、そのためだけに
# ビルド成果物を Python へ持ち込むことになるため設けていない。タイトルを増やす
# 際は両方を更新すること)。自宅マシンの都合で一部だけ受け持ちたい場合は
# `HOME_WORKER_SUPPORTED_GAMES` で上書きする。
DEFAULT_SUPPORTED_GAMES = ("th06", "th07", "th08", "th11")

# `HomeWorkerOfferIndex`(sparse GSI)の名前。`apps/api/src/homeWorker.ts` および
# `infra/lib/sattori-stack.ts` と一致させること。
OFFER_INDEX_NAME = "HomeWorkerOfferIndex"


class ConfigError(Exception):
    """必須の環境変数が欠けている。"""


def _required(name):
    value = os.environ.get(name)
    if not value:
        raise ConfigError(f"必須の環境変数 {name} が設定されていません")
    return value


def _int(name, default):
    raw = os.environ.get(name)
    return default if raw is None or raw == "" else int(raw)


def _float(name, default):
    raw = os.environ.get(name)
    return default if raw is None or raw == "" else float(raw)


def _args(name):
    """`docker run` へ渡す追加引数。シェルと同じ規則(空白区切り・引用符可)で分割する。"""
    raw = os.environ.get(name)
    return tuple(shlex.split(raw)) if raw else ()


def _list(name, default):
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return tuple(default)
    return tuple(item.strip() for item in raw.split(",") if item.strip())


@dataclass(frozen=True)
class Config:
    region: str
    jobs_table: str
    workers_table: str
    log_group: str
    worker_image: str
    #: このワーカーの識別子。`WorkersTable` の主キーであり、ジョブの
    #: `assignedWorkerId` にも書かれる。複数台にする場合は必ず一意にすること。
    worker_id: str
    #: assume する IAM ロール(CfnOutput `HomeWorkerRoleArn`)。未指定なら
    #: 環境の認証情報をそのまま使う(検証用)。
    role_arn: str | None
    #: 同時に走らせる録画の上限。自宅マシンでは4並列まで処理落ちなく録画できる
    #: ことを確認済み(Issue #49)。
    max_concurrency: int
    #: このワーカーが宣言する追加能力(`packages/shared/src/worker.ts` の
    #: `WORKER_CAPABILITIES`)。**実際にできることだけを書く**。1/2倍速録画
    #: (Issue #68)が実装されたら `slow-motion-recording` を足す。
    capabilities: tuple[str, ...]
    supported_games: tuple[str, ...]
    #: オファー用GSIを見に行く間隔(秒)。オファーの待機時間
    #: (`apps/api/src/workerRouting.ts` の `offerWindowSeconds`、既定20秒)に対して
    #: 十分短くする。
    poll_interval_sec: float
    #: 1コアあたりのロードアベレージがこの値を超えている間は新規claimを止める
    #: (実行中のジョブは止めない)。開発者が自宅マシンを使っている最中に録画を
    #: 引き受けて母艦を重くしないためのガード。無効化したい場合は大きな値にする。
    load_threshold: float
    #: ワーカーコンテナに与えるCPU数(`docker run --cpus`)。未指定なら制限しない。
    docker_cpus: str | None
    #: `docker run` に追加で渡す引数(`--shm-size=1g` など)。空白区切り。
    docker_extra_args: tuple[str, ...] = field(default=())
    #: 終了シグナルを受けてから実行中ジョブの完走を待つ上限(秒)。既定は
    #: 録画のタイムアウト(60分)＋変換の余裕。
    drain_timeout_sec: float = 90 * 60
    #: コンテナへ渡す一時認証情報の有効期間(秒)。ロールの `maxSessionDuration`
    #: (CDK側で4時間)以下にすること。
    credential_duration_sec: int = 4 * 60 * 60


def load_config():
    return Config(
        region=os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION") or "eu-south-2",
        jobs_table=_required("JOBS_TABLE"),
        workers_table=_required("WORKERS_TABLE"),
        log_group=os.environ.get("WORKER_LOG_GROUP", "/sattori/worker"),
        worker_image=_required("WORKER_IMAGE"),
        worker_id=os.environ.get("HOME_WORKER_ID", "home-1"),
        role_arn=os.environ.get("HOME_WORKER_ROLE_ARN") or None,
        max_concurrency=_int("HOME_WORKER_MAX_CONCURRENCY", 2),
        capabilities=_list("HOME_WORKER_CAPABILITIES", ()),
        supported_games=_list("HOME_WORKER_SUPPORTED_GAMES", DEFAULT_SUPPORTED_GAMES),
        poll_interval_sec=_float("HOME_WORKER_POLL_INTERVAL_SEC", 3.0),
        load_threshold=_float("HOME_WORKER_LOAD_THRESHOLD", 0.7),
        docker_cpus=os.environ.get("HOME_WORKER_DOCKER_CPUS") or None,
        docker_extra_args=_args("HOME_WORKER_DOCKER_ARGS"),
        drain_timeout_sec=_float("HOME_WORKER_DRAIN_TIMEOUT_SEC", 90 * 60),
        credential_duration_sec=_int("HOME_WORKER_CREDENTIAL_DURATION_SEC", 4 * 60 * 60),
    )
