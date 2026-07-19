"""録画フェーズ中、record_th07.py が書き出す進捗スクリーンショット/状態
(progress_dir/frame.jpg, progress_dir/state.json)をポーリングし、S3へアップロード
しつつDynamoDBへ進捗率を反映するバックグラウンドスレッド(Issue #11)。

スクリーンショットは毎回ユニークなS3キー(progress/{jobId}/{unixMillis}.jpg)で
アップロードする。同一キーを使い回すとCloudFrontの長期キャッシュにより古い画像が
返り続ける恐れがあるため(出力バケットは7日ライフサイクルで自然に削除される)。
"""
import json
import os
import time
import threading

from status import update_progress

POLL_INTERVAL_SEC = 10.0
STOP_JOIN_TIMEOUT_SEC = 5.0


class ProgressReporter:
    def __init__(self, s3, output_bucket, job_id, progress_dir, log=print):
        self._s3 = s3
        self._output_bucket = output_bucket
        self._job_id = job_id
        self._progress_dir = progress_dir
        self._log = log
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._last_mtime = None

    def start(self):
        self._thread.start()

    def stop(self):
        self._stop.set()
        self._thread.join(timeout=STOP_JOIN_TIMEOUT_SEC)

    def _run(self):
        while not self._stop.is_set():
            self._tick()
            self._stop.wait(POLL_INTERVAL_SEC)
        self._tick()  # 停止直前の最新状態も反映する

    def _tick(self):
        frame_path = f"{self._progress_dir}/frame.jpg"
        state_path = f"{self._progress_dir}/state.json"
        if not os.path.exists(frame_path) or not os.path.exists(state_path):
            return
        mtime = os.path.getmtime(frame_path)
        if mtime == self._last_mtime:
            return
        self._last_mtime = mtime

        try:
            with open(state_path) as f:
                state = json.load(f)
            elapsed = state.get("elapsedSeconds")
            expected = state.get("expectedDurationSeconds")
            percent = None
            if elapsed is not None and expected:
                percent = min(99, round(elapsed / expected * 100))

            key = f"progress/{self._job_id}/{int(time.time() * 1000)}.jpg"
            self._s3.upload_file(
                frame_path, self._output_bucket, key,
                ExtraArgs={"ContentType": "image/jpeg"},
            )
            update_progress(self._job_id, percent, preview_image_path=key)
        except Exception as err:  # noqa: BLE001 - 進捗レポートの失敗で録画自体は止めない
            self._log(f"[progress_reporter] 進捗レポート失敗(継続): {err}")
