"""EC2 Spot中断通知(2分前、実際に発効が確定した通知)とインスタンスリバランス推奨
(発効するとは限らない予測的シグナル)をインスタンスメタデータ(IMDSv2)経由で監視する
(Issue #11)。

Spot中断通知(`spot/instance-action`)を検知した場合のみ、60分のtaskTokenタイムアウトを
待たずに即座にコールバックを呼び、Step Functionsへ早期失敗通知して後続のリトライ
(新インスタンス起動)を早める。検知してもこのインスタンス自体の録画処理は止めない
(中断が実際に発効するまで録画を続け、できるところまで進める)。

リバランス推奨(`events/recommendations/rebalance`)は実際の中断を伴わないことが多い
予測的シグナルであるため、検知してもコールバックは呼ばない(ジョブを失敗扱いにしない)。
ログにのみ記録し、実際のSpot中断通知が来ないか監視を継続する。EC2 Fleetの
AllocationStrategyを`lowest-price`に固定している(コスト優先)ため、リバランス推奨自体は
比較的発生しやすい前提。これをそのまま早期失敗の合図にすると、実際には最後まで
完走できたはずのジョブまで不要にリトライしてしまう。
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
        self._rebalance_logged = False
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
                if rebalance is not None and not self._rebalance_logged:
                    self._rebalance_logged = True
                    self._log(
                        f"[interruption_watcher] リバランス推奨を検知(発効するとは限らないため"
                        f"失敗扱いにせず処理を継続、実中断の監視は継続): {rebalance}"
                    )
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
