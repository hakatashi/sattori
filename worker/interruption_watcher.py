"""EC2 Spot中断通知(2分前)とインスタンスリバランス推奨をインスタンスメタデータ
(IMDSv2)経由で監視し、検知したら即座にコールバックを呼ぶ(Issue #11)。

60分のtaskTokenタイムアウトを待たずに検知した時点でStep Functionsへ失敗通知する
ことで、後続のリトライ(新インスタンス起動)を早めに開始させるのが狙い。検知しても
このインスタンス自体の録画処理は止めない(中断が実際に発効するまで録画を続け、
できるところまで進める)。
"""
import json
import threading
import time
import urllib.error
import urllib.request

IMDS_BASE = "http://169.254.169.254/latest"
TOKEN_TTL_SECONDS = "21600"
POLL_INTERVAL_SEC = 5.0
REQUEST_TIMEOUT_SEC = 2.0


class InterruptionWatcher:
    def __init__(self, on_interruption, log=print):
        self._on_interruption = on_interruption
        self._log = log
        self._stop = threading.Event()
        self._fired = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)

    def start(self):
        self._thread.start()

    def stop(self):
        self._stop.set()

    def _get_token(self):
        req = urllib.request.Request(
            f"{IMDS_BASE}/api/token", method="PUT",
            headers={"X-aws-ec2-metadata-token-ttl-seconds": TOKEN_TTL_SECONDS},
        )
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT_SEC) as resp:
            return resp.read().decode()

    def _check(self, token, path):
        """該当の通知が無ければ None(IMDSは未設定時に404を返す)。"""
        req = urllib.request.Request(
            f"{IMDS_BASE}/meta-data/{path}",
            headers={"X-aws-ec2-metadata-token": token},
        )
        try:
            with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT_SEC) as resp:
                return json.loads(resp.read().decode())
        except urllib.error.HTTPError as err:
            if err.code == 404:
                return None
            raise

    def _run(self):
        while not self._stop.is_set():
            try:
                token = self._get_token()
                interruption = self._check(token, "spot/instance-action")
                if interruption is not None:
                    self._fire("spot_interruption", interruption)
                    return
                rebalance = self._check(token, "events/recommendations/rebalance")
                if rebalance is not None:
                    self._fire("rebalance_recommendation", rebalance)
                    return
            except Exception as err:  # noqa: BLE001 - IMDS一時応答不能等でも録画は継続する
                self._log(f"[interruption_watcher] 確認に失敗(継続): {err}")
            self._stop.wait(POLL_INTERVAL_SEC)

    def _fire(self, reason, detail):
        if self._fired.is_set():
            return
        self._fired.set()
        self._log(f"[interruption_watcher] 検知: {reason} {detail}")
        try:
            self._on_interruption(reason, detail)
        except Exception as err:  # noqa: BLE001 - 通知コールバックの失敗で録画自体は止めない
            self._log(f"[interruption_watcher] on_interruption 呼び出しに失敗: {err}")
