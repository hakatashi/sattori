"""Step Functions の `waitForTaskToken` タスクへ定期的にハートビートを送る
バックグラウンドスレッド(Issue #49)。

Launch ステートには `HeartbeatSeconds`(15分、`infra/lib/sattori-stack.ts`)が
設定してあり、この間隔で `SendTaskHeartbeat` が届かないとタスクが
`States.Timeout` で失敗して `HandleFailure` が後始末に入る。

**主目的は自宅ワーカー(Issue #49)の死活監視**である。EC2ワーカーであれば
停電・Spot中断はインスタンスの消滅としてAWS側から観測できるが、自宅マシンの
停電・回線断・クラッシュはAWSから一切見えない。これが無いと、claim したまま
死んだワーカーのジョブがタスクタイムアウト(90分)まで「録画中」で固まる。
ハートビートが途切れれば `HandleFailure` が claim を解除し(＝復帰したデーモンが
録画を続けないようにし)、EC2 でやり直せる。

EC2 ワーカーにとっても、インスタンスがハングした場合の失敗検知が
90分から15分へ縮まるという副次的な利点がある(実行経路はワーカーの種別に
よらず同一。`workerEnv.ts` の方針)。

ハートビート送信の失敗は握りつぶしてログにのみ残す。一時的なAPIエラーで
録画そのものを落とす価値は無く、本当に送れない状態が15分続けば
Step Functions 側が勝手にタイムアウトさせてくれるため。
"""
import threading

import boto3

# 送信間隔(秒)。タイムアウト(15分)に対して十分に余裕を持たせ、数回連続で
# 失敗しても即座にタイムアウトしないようにする。
INTERVAL_SEC = 60.0


class TaskHeartbeat:
    def __init__(self, task_token, log=print, interval_sec=INTERVAL_SEC, client=None):
        self._task_token = task_token
        self._log = log
        self._interval_sec = interval_sec
        self._client = client
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)

    def start(self):
        # taskToken 無しで動かす場合(ローカル検証)は何もしない。
        if not self._task_token:
            return
        self._thread.start()

    def stop(self):
        self._stop.set()

    def _sfn(self):
        if self._client is None:
            self._client = boto3.client("stepfunctions")
        return self._client

    def _run(self):
        # 最初の1回は起動直後に送る。タイトル資産のダウンロード(数分かかりうる)の
        # 前に「ワーカーは生きている」ことを知らせておくため。
        while not self._stop.is_set():
            try:
                self._sfn().send_task_heartbeat(taskToken=self._task_token)
            except Exception as err:  # noqa: BLE001 - 送信失敗で録画自体は止めない
                # taskToken が既に消費済み(中断による早期失敗通知の後など)の場合も
                # ここに来る。その場合は送り続けても無意味なので停止する。
                name = type(err).__name__
                if name in ("TaskTimedOut", "TaskDoesNotExist"):
                    self._log(f"[task_heartbeat] taskTokenが無効になったため送信を停止します: {name}")
                    return
                self._log(f"[task_heartbeat] ハートビート送信に失敗(継続): {err}")
            self._stop.wait(self._interval_sec)
