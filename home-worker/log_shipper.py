"""ワーカーコンテナの標準出力を CloudWatch Logs へ転送する(Issue #49)。

EC2ワーカーでは docker の `awslogs` ログドライバがこれを担うが、そのドライバは
**dockerデーモン自身の**AWS認証情報を使う。自宅マシンのdockerデーモンに
認証情報を持たせるのは設定が煩雑なうえ、デーモン全体に権限が漏れるため避けたい。
代わりにこのプロセスがコンテナの出力を読み、EC2ワーカーと**同じロググループ・
同じストリーム名(=jobId)**へ書く。こうすることで管理画面のログ表示(Issue #58)は
ワーカーの種別を意識せずに済む。

`PutLogEvents` はシーケンストークン不要(2023年以降)なので、素朴にバッファして
投げるだけでよい。ログ転送の失敗で録画を止めることはしない(診断情報の欠落より
録画結果を失うほうが損失が大きい)。
"""
import time

#: 1回のPutLogEventsに詰める最大件数(APIの上限は10000件/1MB)。
MAX_BATCH_SIZE = 500

#: バッファをflushするまでの最大待ち時間(秒)。
FLUSH_INTERVAL_SEC = 5.0


class CloudWatchLogShipper:
    def __init__(self, client, log_group, log_stream, log=print, now=time.time):
        self._client = client
        self._log_group = log_group
        self._log_stream = log_stream
        self._log = log
        self._now = now
        self._buffer = []
        self._last_flush = now()
        self._stream_ready = False
        self._disabled = False

    def _ensure_stream(self):
        if self._stream_ready:
            return
        try:
            self._client.create_log_stream(
                logGroupName=self._log_group, logStreamName=self._log_stream
            )
        except Exception as err:  # noqa: BLE001 - 既存ストリームの再作成は正常系
            if type(err).__name__ != "ResourceAlreadyExistsException":
                raise
        self._stream_ready = True

    def append(self, message):
        if self._disabled:
            return
        self._buffer.append({"timestamp": int(self._now() * 1000), "message": message})
        if len(self._buffer) >= MAX_BATCH_SIZE or (
            self._now() - self._last_flush >= FLUSH_INTERVAL_SEC
        ):
            self.flush()

    def flush(self):
        if self._disabled or not self._buffer:
            self._last_flush = self._now()
            return
        events, self._buffer = self._buffer, []
        try:
            self._ensure_stream()
            self._client.put_log_events(
                logGroupName=self._log_group,
                logStreamName=self._log_stream,
                logEvents=events,
            )
        except Exception as err:  # noqa: BLE001 - ログ転送の失敗で録画は止めない
            self._log(f"[log_shipper] CloudWatch Logsへの転送に失敗(以降は転送を諦めます): {err}")
            self._disabled = True
        finally:
            self._last_flush = self._now()
