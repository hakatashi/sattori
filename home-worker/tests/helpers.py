"""テスト用のヘルパー(pytestの`prepend`インポートモードにより`tests/`が
sys.pathへ入るため、`from helpers import ...`で参照できる)。
"""
from config import Config


def make_config(**overrides):
    base = dict(
        region="eu-south-2",
        jobs_table="jobs",
        workers_table="workers",
        log_group="/sattori/worker",
        worker_image="registry/sattori-worker:latest",
        worker_id="home-1",
        role_arn=None,
        max_concurrency=2,
        capabilities=(),
        supported_games=("th06", "th07"),
        poll_interval_sec=3.0,
        load_threshold=0.7,
        docker_cpus=None,
    )
    base.update(overrides)
    return Config(**base)
