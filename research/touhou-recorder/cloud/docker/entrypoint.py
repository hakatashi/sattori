#!/usr/bin/env python3
"""クラウド録画ワーカーのエントリポイント。
PulseAudioのnull sinkを起動し、既存のscripts/11_record_th07_replay_e2e.pyを
そのまま実行、結果(動画・ログ)をCloud Storageにアップロードする。
所要時間計測はコスト試算のためにログへ明示的に出力する。
"""
import datetime
import os
import subprocess
import sys
import time

REPO = "/app"
REPLAY_FILE = os.environ.get("REPLAY_FILE", "th7_07.rpy")
OUTPUT_BUCKET = os.environ.get("OUTPUT_BUCKET", "gs://touhou-recorder-output")
JOB_NAME = os.environ.get("CLOUD_RUN_JOB") or os.environ.get("JOB_NAME") or "local"
TASK_INDEX = os.environ.get("CLOUD_RUN_TASK_INDEX", "0")
RUN_ID = os.environ.get("RUN_ID") or datetime.datetime.now().strftime("%Y%m%d%H%M%S")

LOCAL_OUTPUT_DIR = f"/app/runs/{RUN_ID}"
LOCAL_VIDEO = f"{LOCAL_OUTPUT_DIR}/video.mp4"
LOCAL_STDOUT_LOG = f"{LOCAL_OUTPUT_DIR}/record_stdout.log"


def log(msg):
    print(f"[entrypoint {time.strftime('%H:%M:%S')}] {msg}", flush=True)


def start_pulseaudio():
    # pulseaudioはハードウェアが無い環境では起動時に自動でnull sink "auto_null"
    # (と"auto_null.monitor"ソース)を作成する。ここで同名sinkを手動追加すると
    # "auto_null.2"にリネームされてしまい、scripts/11_...が期待する
    # "auto_null.monitor"が存在せずffmpegの録画が即座に失敗する(実機検証で確認済み)。
    log("pulseaudio を起動します(auto_nullは自動生成されるため追加のsink作成は行わない)")
    subprocess.run(["pulseaudio", "-D", "--exit-idle-time=-1", "--disallow-exit"], check=False)
    time.sleep(2.0)


def upload_to_gcs():
    from google.cloud import storage

    bucket_name = OUTPUT_BUCKET.replace("gs://", "").split("/")[0]
    client = storage.Client()
    bucket = client.bucket(bucket_name)
    prefix = f"{JOB_NAME}/{RUN_ID}-task{TASK_INDEX}"

    for local_path, suffix in [(LOCAL_VIDEO, "video.mp4"), (LOCAL_STDOUT_LOG, "record_stdout.log")]:
        if not os.path.exists(local_path):
            log(f"WARNING: アップロード対象が見つかりません: {local_path}")
            continue
        blob_name = f"{prefix}/{suffix}"
        blob = bucket.blob(blob_name)
        t0 = time.time()
        blob.upload_from_filename(local_path)
        size_mb = os.path.getsize(local_path) / (1024 * 1024)
        log(f"アップロード完了: gs://{bucket_name}/{blob_name} ({size_mb:.1f}MB, {time.time()-t0:.1f}s)")


def main():
    os.makedirs(LOCAL_OUTPUT_DIR, exist_ok=True)
    log(f"録画開始 replay={REPLAY_FILE} run_id={RUN_ID}")

    start_pulseaudio()

    wall_t0 = time.time()
    with open(LOCAL_STDOUT_LOG, "w") as logf:
        proc = subprocess.run(
            [
                "python3", f"{REPO}/scripts/11_record_th07_replay_e2e.py",
                "--replay", REPLAY_FILE,
                "--output", LOCAL_VIDEO,
            ],
            stdout=logf, stderr=subprocess.STDOUT,
        )
    wall_elapsed = time.time() - wall_t0
    log(f"録画スクリプト終了 exit_code={proc.returncode} wall_elapsed={wall_elapsed:.1f}s")

    upload_to_gcs()

    log(f"全工程完了 total_wall_elapsed={time.time()-wall_t0:.1f}s")
    sys.exit(proc.returncode)


if __name__ == "__main__":
    main()
