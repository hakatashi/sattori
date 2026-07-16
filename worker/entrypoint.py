#!/usr/bin/env python3
"""Sattori 録画ワーカーのエントリポイント。

EC2 Spot インスタンスの UserData から `docker run` で起動される。処理の流れ:
  1. DynamoDB のジョブ状態を recording に更新
  2. S3(REPLAY_BUCKET/REPLAY_KEY)からアップロード済みリプレイをダウンロード
  3. PulseAudio を起動し record_th07.py で録画
  4. 出力動画を S3(OUTPUT_BUCKET)へアップロード
  5. DynamoDB を done(outputPath 付き)/ failed に更新

ジョブ固有の値はすべて環境変数で渡される(apps/api の ec2.buildUserData 参照)。
"""
import os
import subprocess
import sys
import time

import boto3

from status import update_status

JOB_ID = os.environ["JOB_ID"]
GAME = os.environ.get("GAME", "th07")
REPLAY_BUCKET = os.environ["REPLAY_BUCKET"]
REPLAY_KEY = os.environ["REPLAY_KEY"]
OUTPUT_BUCKET = os.environ["OUTPUT_BUCKET"]
WATERMARK = os.environ.get("WATERMARK", "1") == "1"

REPO = "/app"
WORK_DIR = f"/app/runs/{JOB_ID}"
REPLAY_PATH = f"{WORK_DIR}/upload.rpy"
OUTPUT_VIDEO = f"{WORK_DIR}/video.mp4"
# 出力オブジェクトキー。CloudFront はこのキーをパスとして配信する。
OUTPUT_KEY = f"videos/{JOB_ID}.mp4"
WATERMARK_ASSET = f"{REPO}/assets/watermark/watermark-60fps.webm"


def log(msg):
    print(f"[entrypoint {time.strftime('%H:%M:%S')}] {msg}", flush=True)


def start_pulseaudio():
    # auto_null sink は起動時に自動生成されるため手動追加しない
    # (追加すると auto_null.2 にリネームされ録画が失敗する, PoC で確認済み)。
    log("pulseaudio を起動します")
    subprocess.run(["pulseaudio", "-D", "--exit-idle-time=-1", "--disallow-exit"], check=False)
    time.sleep(2.0)


def download_replay(s3):
    log(f"リプレイをダウンロード: s3://{REPLAY_BUCKET}/{REPLAY_KEY}")
    s3.download_file(REPLAY_BUCKET, REPLAY_KEY, REPLAY_PATH)


def upload_output(s3):
    log(f"録画をアップロード: s3://{OUTPUT_BUCKET}/{OUTPUT_KEY}")
    s3.upload_file(
        OUTPUT_VIDEO, OUTPUT_BUCKET, OUTPUT_KEY,
        ExtraArgs={"ContentType": "video/mp4"},
    )


def main():
    os.makedirs(WORK_DIR, exist_ok=True)
    s3 = boto3.client("s3")
    log(f"ジョブ開始 job_id={JOB_ID} game={GAME} watermark={WATERMARK}")

    try:
        download_replay(s3)
        start_pulseaudio()
        update_status(JOB_ID, "recording")

        cmd = [
            "python3", f"{REPO}/record_th07.py",
            "--replay-path", REPLAY_PATH,
            "--output", OUTPUT_VIDEO,
        ]
        if WATERMARK:
            cmd += ["--watermark", WATERMARK_ASSET]

        result = subprocess.run(cmd)
        if result.returncode != 0 or not os.path.exists(OUTPUT_VIDEO):
            raise RuntimeError(f"録画に失敗しました (exit_code={result.returncode})")

        update_status(JOB_ID, "uploading")
        upload_output(s3)
        update_status(JOB_ID, "done", output_path=OUTPUT_KEY)
        log("ジョブ完了")
    except Exception as err:  # noqa: BLE001 - 失敗はすべて failed として記録する
        log(f"ERROR: {err}")
        update_status(JOB_ID, "failed", error="録画処理中にエラーが発生しました")
        sys.exit(1)


if __name__ == "__main__":
    main()
