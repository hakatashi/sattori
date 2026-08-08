"""ワーカーコンテナ(ECRの`sattori-worker`イメージ)の実行(Issue #49)。

**EC2ワーカーとまったく同じイメージを、まったく同じ環境変数で動かす**のが要点。
環境変数はAWS側(`apps/api/src/workerEnv.ts`)が組み立ててオファーに添えたものを
そのまま渡すだけで、このデーモンは中身を解釈しない。ワーカー内のロジックに
「自宅かEC2か」の分岐を持ち込まないための構造で、1/2倍速録画(Issue #68)のような
自宅限定の挙動も、起動側が渡す環境変数の違いとして表現される。

EC2との違いは、コンテナに渡すAWS認証情報(インスタンスプロファイルが無いため
`credentials.py` が発行した一時認証情報を環境変数で渡す)と、ログの送り方
(`log_shipper.py`)の2点だけ。
"""
import base64
import subprocess
import threading

#: `docker run --name` に付ける接頭辞。`docker ps` で自宅の録画コンテナだけを
#: 見分けられるようにする(claim取り消し時の `docker kill` もこの名前で行う)。
CONTAINER_NAME_PREFIX = "sattori-job-"

#: ECRログイン・イメージpullの再試行回数(EC2のUserDataと揃える)。
RETRY_COUNT = 3


class ImagePreparationError(Exception):
    """ECRログインまたはイメージpullに失敗した(=コンテナを起動できない)。"""


def container_name(job_id):
    return f"{CONTAINER_NAME_PREFIX}{job_id}"


def registry_of(image):
    return image.split("/")[0]


def build_docker_command(config, job_id, env):
    """`docker run` のコマンドライン。

    環境変数には taskToken と一時認証情報が含まれるため、**この戻り値をそのまま
    ログへ出してはいけない**(ログ用には `redact_command()` を使う)。
    """
    cmd = ["docker", "run", "--rm", "--name", container_name(job_id)]
    if config.docker_cpus:
        cmd += ["--cpus", str(config.docker_cpus)]
    cmd += list(config.docker_extra_args)
    for key in sorted(env):
        cmd += ["-e", f"{key}={env[key]}"]
    cmd.append(config.worker_image)
    return cmd


#: 値をログに出してはいけない環境変数。
SECRET_ENV_KEYS = frozenset(
    {"TASK_TOKEN", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"}
)


def redact_command(cmd):
    """`build_docker_command()` の結果から秘密値を伏せたコピー(ログ用)。"""
    redacted = []
    for item in cmd:
        key, sep, _value = item.partition("=")
        if sep and key in SECRET_ENV_KEYS:
            redacted.append(f"{key}=***")
        else:
            redacted.append(item)
    return redacted


def ecr_login(ecr_client, image, log=print, run=subprocess.run):
    """ECRへ `docker login` する。トークンは12時間有効だがジョブ毎に取り直す
    (取得は安価で、期限管理を持ち込むより単純)。"""
    token = ecr_client.get_authorization_token()["authorizationData"][0]["authorizationToken"]
    user, _, password = base64.b64decode(token).decode().partition(":")
    result = run(
        ["docker", "login", "--username", user, "--password-stdin", registry_of(image)],
        input=password,
        text=True,
        capture_output=True,
    )
    if result.returncode != 0:
        raise ImagePreparationError(f"docker login に失敗しました: {result.stderr.strip()}")
    log("[runner] ECRへログインしました")


def pull_image(image, log=print, run=subprocess.run):
    for attempt in range(1, RETRY_COUNT + 1):
        result = run(["docker", "pull", image], capture_output=True, text=True)
        if result.returncode == 0:
            return
        log(f"[runner] docker pull 失敗(試行{attempt}回目): {result.stderr.strip()}")
    raise ImagePreparationError(f"docker pull に{RETRY_COUNT}回失敗しました: {image}")


class ContainerRun:
    """1ジョブぶんのコンテナ実行。`run()` は完了までブロックし、`kill()` は
    別スレッド(claim取り消しの検知)から呼ばれる。"""

    def __init__(self, config, job_id, env, log=print, popen=subprocess.Popen,
                 run=subprocess.run):
        self._config = config
        self._job_id = job_id
        self._env = env
        self._log = log
        self._popen = popen
        self._run = run
        self._process = None
        self._killed = threading.Event()

    @property
    def killed(self):
        return self._killed.is_set()

    def run(self, on_line):
        """コンテナを起動し、標準出力の各行を `on_line` へ渡す。終了コードを返す。"""
        cmd = build_docker_command(self._config, self._job_id, self._env)
        self._log(f"[runner] コンテナを起動します: {' '.join(redact_command(cmd))}")
        self._process = self._popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
        for line in self._process.stdout:
            on_line(line.rstrip("\n"))
        return self._process.wait()

    def kill(self):
        """コンテナを停止する。claimが取り消された(=別経路でリトライが始まった)
        ときに呼ぶ。放置すると同じリプレイを二重に録画してしまう。"""
        self._killed.set()
        self._run(
            ["docker", "kill", container_name(self._job_id)],
            capture_output=True,
            text=True,
        )
