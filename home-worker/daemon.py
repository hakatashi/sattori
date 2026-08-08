#!/usr/bin/env python3
"""自宅サーバーを追加の録画ワーカーとして動かす常駐デーモン(Issue #49)。

自宅マシンは動的グローバルIP・NAT配下でAWS側から到達できないため、
**AWSが自宅を叩くのではなく、自宅がジョブを取りに行くPull型**にしている。
1周ごとに:

  1. 自身の空き状況を `WorkersTable` へハートビートとして書く。
  2. 余力があれば、オファー中のジョブ(sparse GSI `HomeWorkerOfferIndex`)を探し、
     条件付き更新で原子的にclaimする。
  3. claimできたらワーカーコンテナ(EC2と同一のECRイメージ)を起動し、その出力を
     CloudWatch Logs へ転送する。録画の成否はコンテナ自身が taskToken 経由で
     Step Functions へ通知するので、このデーモンは通知に関与しない
     (コンテナが起動すらできなかった場合の失敗通知だけは肩代わりする)。

実行中は30秒ごとに「claimがまだ自分のものか」を条件付き更新で確かめる。
AWS側(`HandleFailure`・管理画面からの緊急停止)が `assignedWorkerId` を消すことが
**claimの取り消し**なので、条件が崩れたら即座にコンテナを停止する。これを怠ると、
既に別経路でリトライが始まっているジョブを二重に録画してしまう。

SIGTERM/SIGINT を受けたら新規claimを止め、実行中のジョブは完走を待ってから終了する
(走り出した録画を落とすと、節約できるCPU時間よりはるかに大きな無駄になるため)。

起動方法・IAM設定・systemdユニットの例は `home-worker/README.md` を参照。
"""
import signal
import sys
import threading
import time

import capacity
import claim as claim_module
import heartbeat as heartbeat_module
from config import ConfigError, load_config
from credentials import CredentialProvider
from log_shipper import CloudWatchLogShipper
from runner import ContainerRun, ImagePreparationError, ecr_login, pull_image

#: 実行中ジョブのclaimが自分のものか確認する間隔(秒)。取り消しの検知が遅れるほど
#: 二重録画の窓が広がるので、短めにする(DynamoDBの更新1回ぶんの負荷しかない)。
CLAIM_CHECK_INTERVAL_SEC = 30.0


def log(message):
    print(f"[home-worker {time.strftime('%H:%M:%S')}] {message}", flush=True)


class HomeWorkerDaemon:
    def __init__(self, config, credentials=None, log=log):
        self._config = config
        self._log = log
        self._credentials = credentials or CredentialProvider(
            region=config.region,
            role_arn=config.role_arn,
            duration_sec=config.credential_duration_sec,
            log=log,
        )
        self._stopping = threading.Event()
        self._jobs_lock = threading.Lock()
        #: jobId -> ContainerRun。実行中ジョブの一覧(claim取り消し時の停止に使う)。
        self._running = {}
        self._threads = []
        self._last_heartbeat_at = 0.0

    # --- AWSクライアント ---------------------------------------------------
    # 認証情報は期限付きなので、都度セッションを作り直す(`credentials.py`が
    # 期限を見て必要なときだけassumeし直す)。

    def _jobs_table(self):
        return self._credentials.session().resource("dynamodb").Table(self._config.jobs_table)

    def _workers_table(self):
        return self._credentials.session().resource("dynamodb").Table(self._config.workers_table)

    # --- メインループ -------------------------------------------------------

    def stop(self):
        self._stopping.set()

    def active_jobs(self):
        with self._jobs_lock:
            return len(self._running)

    def run_forever(self):
        self._log(
            f"起動しました workerId={self._config.worker_id} "
            f"maxConcurrency={self._config.max_concurrency} "
            f"games={','.join(self._config.supported_games)} "
            f"capabilities={','.join(self._config.capabilities) or '(なし)'}"
        )
        while not self._stopping.is_set():
            try:
                self._tick()
            except Exception as err:  # noqa: BLE001 - 一時的なAPI障害でデーモンを落とさない
                self._log(f"ループでエラーが発生しました(継続): {err}")
            self._stopping.wait(self._config.poll_interval_sec)
        self._drain()

    def _tick(self):
        active = self.active_jobs()
        load = capacity.load_per_cpu()
        accepting = not self._stopping.is_set() and capacity.can_accept(
            self._config, active, load=load
        )
        self._publish_heartbeat(accepting=accepting, active_jobs=active)
        if accepting:
            self._claim_offers(available_slots=self._config.max_concurrency - active)

    def _publish_heartbeat(self, *, accepting, active_jobs):
        now = time.time()
        if now - self._last_heartbeat_at < heartbeat_module.INTERVAL_SEC:
            return
        heartbeat_module.publish(
            self._workers_table(), self._config, accepting=accepting, active_jobs=active_jobs
        )
        self._last_heartbeat_at = now

    def _claim_offers(self, *, available_slots):
        table = self._jobs_table()
        for offer in claim_module.find_open_offers(table):
            if available_slots <= 0 or self._stopping.is_set():
                return
            job_id = offer.get("jobId")
            game = offer.get("game")
            if job_id is None or game not in self._config.supported_games:
                continue
            job = claim_module.claim_job(table, job_id, self._config.worker_id)
            if job is None:
                # 他のワーカー/スレッドが先に取ったか、期限切れ。次のオファーへ。
                continue
            self._log(f"ジョブをclaimしました job_id={job_id} game={game}")
            available_slots -= 1
            self._start_job(job)

    def _start_job(self, job):
        job_id = job["jobId"]
        thread = threading.Thread(target=self._run_job, args=(job,), daemon=True)
        with self._jobs_lock:
            # ContainerRun はコンテナ起動時に差し替える。ここではスロットの予約として
            # None を入れ、並列度の計算に含める。
            self._running[job_id] = None
        self._threads.append(thread)
        thread.start()

    # --- ジョブ1本の実行 ----------------------------------------------------

    def _run_job(self, job):
        job_id = job["jobId"]
        session = self._credentials.session()
        table = session.resource("dynamodb").Table(self._config.jobs_table)
        shipper = CloudWatchLogShipper(
            session.client("logs"), self._config.log_group, job_id, log=self._log
        )
        container = None
        try:
            env = dict(job.get("homeWorkerEnv") or {})
            if not env:
                raise ImagePreparationError("オファーにワーカー環境変数が含まれていません")
            # EC2のインスタンスプロファイルに相当する認証情報をコンテナへ渡す。
            env.update(self._credentials.container_env())

            ecr_login(session.client("ecr"), self._config.worker_image, log=self._log)
            pull_image(self._config.worker_image, log=self._log)

            container = ContainerRun(self._config, job_id, env, log=self._log)
            with self._jobs_lock:
                self._running[job_id] = container

            watchdog = threading.Thread(
                target=self._watch_claim, args=(table, job_id, container), daemon=True
            )
            watchdog.start()

            exit_code = container.run(shipper.append)
            shipper.flush()
            self._finish_job(session, table, job, env, container, exit_code)
        except ImagePreparationError as err:
            # コンテナを一度も起動できなかった＝ワーカー内部の失敗通知が走らない。
            # EC2のUserDataが bootstrap 失敗を自分で通知するのと同じ役割を果たす。
            self._log(f"ジョブを開始できませんでした job_id={job_id}: {err}")
            self._notify_failure(
                session, job.get("homeWorkerEnv"), "HomeWorkerBootstrapFailure", str(err)
            )
            claim_module.release_claim(table, job_id, self._config.worker_id)
        except Exception as err:  # noqa: BLE001 - 想定外でもデーモン全体は止めない
            self._log(f"ジョブの実行中にエラーが発生しました job_id={job_id}: {err}")
            self._notify_failure(session, job.get("homeWorkerEnv"), "HomeWorkerFailed", str(err))
            claim_module.release_claim(table, job_id, self._config.worker_id)
        finally:
            shipper.flush()
            with self._jobs_lock:
                self._running.pop(job_id, None)

    def _finish_job(self, session, table, job, env, container, exit_code):
        job_id = job["jobId"]
        if container.killed:
            # claim取り消しによる停止。Step Functions側は既に別経路で処理を進めて
            # いるため、ここから成否を通知してはいけない。
            self._log(f"claimが取り消されたためコンテナを停止しました job_id={job_id}")
            return

        self._log(f"コンテナが終了しました job_id={job_id} exit_code={exit_code}")
        if exit_code != 0:
            # 通常はワーカー自身(entrypoint.py)が失敗を通知済みで、この通知は
            # 消費済みトークンへの空振りになる。OOM killのようにワーカーが自分で
            # 通知する間もなく落ちた場合の保険としてだけ意味がある。
            self._notify_failure(
                session, env, "HomeWorkerContainerFailed", f"container exited with {exit_code}"
            )
        # 使用済みtaskTokenをジョブレコードに残さない。
        claim_module.clear_worker_env(table, job_id, self._config.worker_id)

    def _notify_failure(self, session, env, error, cause):
        token = (env or {}).get("TASK_TOKEN")
        if not token:
            return
        try:
            session.client("stepfunctions").send_task_failure(
                taskToken=token, error=error, cause=str(cause)[:32000]
            )
        except Exception as err:  # noqa: BLE001 - 消費済みトークンなら失敗して当然
            self._log(f"taskTokenへの失敗通知をスキップしました: {err}")

    def _watch_claim(self, table, job_id, container):
        """claimが自分のものであり続けるかを見張る。"""
        while not container.killed:
            time.sleep(CLAIM_CHECK_INTERVAL_SEC)
            with self._jobs_lock:
                if self._running.get(job_id) is not container:
                    return
            try:
                still_mine = claim_module.touch_claim(table, job_id, self._config.worker_id)
            except Exception as err:  # noqa: BLE001 - 一時的なAPI障害では止めない
                self._log(f"claimの確認に失敗しました(継続) job_id={job_id}: {err}")
                continue
            if not still_mine:
                self._log(f"claimが取り消されました。コンテナを停止します job_id={job_id}")
                container.kill()
                return

    # --- 終了処理 -----------------------------------------------------------

    def _drain(self):
        """新規claimを止めた状態で、実行中ジョブの完走を待つ。"""
        active = self.active_jobs()
        if active == 0:
            self._log("実行中のジョブはありません。終了します")
            return
        self._log(f"{active}件のジョブの完走を待ちます(最大{int(self._config.drain_timeout_sec)}秒)")
        deadline = time.time() + self._config.drain_timeout_sec
        while self.active_jobs() > 0 and time.time() < deadline:
            # ドレイン中も「受付停止」のハートビートは出し続ける。止めてしまうと
            # AWS側からは落ちたように見え、実行中ジョブのclaimを解除されかねない。
            try:
                self._publish_heartbeat(accepting=False, active_jobs=self.active_jobs())
            except Exception as err:  # noqa: BLE001
                self._log(f"ドレイン中のハートビートに失敗しました(継続): {err}")
            time.sleep(1.0)
        remaining = self.active_jobs()
        if remaining > 0:
            self._log(f"待機時間を超過しました。{remaining}件のジョブを残して終了します")


def main():
    try:
        config = load_config()
    except ConfigError as err:
        print(f"設定エラー: {err}", file=sys.stderr)
        return 2

    daemon = HomeWorkerDaemon(config)

    def handle_signal(signum, _frame):
        log(f"シグナル {signum} を受信しました。新規claimを停止します")
        daemon.stop()

    signal.signal(signal.SIGTERM, handle_signal)
    signal.signal(signal.SIGINT, handle_signal)

    daemon.run_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
