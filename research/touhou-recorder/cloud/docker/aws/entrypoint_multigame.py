#!/usr/bin/env python3
"""クラウド録画ワーカーのエントリポイント(AWS版、th07/th08共通)。
GAME環境変数("th07"または"th08")でscripts/25_record_replay_e2e_multigame.pyに
渡す--gameフラグを切り替える。フェーズ24の重複フレーム率問題がth08固有か
パイプライン/AWS環境固有かを切り分けるための比較検証用(reports/25参照)。
"""
import datetime
import os
import subprocess
import sys
import time

REPO = "/app"
GAME = os.environ.get("GAME", "th08")
REPLAY_FILE = os.environ.get("REPLAY_FILE", "")
OUTPUT_BUCKET = os.environ.get("OUTPUT_BUCKET", "touhou-recorder-output")
RUN_ID = os.environ.get("RUN_ID") or datetime.datetime.now().strftime("%Y%m%d%H%M%S")
WATERMARK_PATH = os.environ.get("WATERMARK_PATH", "")
WATERMARK_WIDTH = os.environ.get("WATERMARK_WIDTH", "285")
UPSCALE_720P = os.environ.get("UPSCALE_720P", "").lower() in ("1", "true", "yes")
MAX_ATTEMPTS = os.environ.get("MAX_ATTEMPTS", "3")
RECORD_SECONDS = os.environ.get("RECORD_SECONDS", "")
# th128(妖精大戦争)はリプレイ選択直後のフリーズ回避のため--thprac必須
# (touhou-recorder reports/70)。THPRAC=1でscripts/25に--thpracを渡す。
THPRAC = os.environ.get("THPRAC", "").lower() in ("1", "true", "yes")

LOCAL_OUTPUT_DIR = f"/app/runs/{RUN_ID}"
LOCAL_VIDEO = f"{LOCAL_OUTPUT_DIR}/video.mp4"
LOCAL_STDOUT_LOG = f"{LOCAL_OUTPUT_DIR}/record_stdout.log"


def log(msg):
    print(f"[entrypoint {time.strftime('%H:%M:%S')}] {msg}", flush=True)


def start_pulseaudio():
    log("pulseaudio を起動します(auto_nullは自動生成されるため追加のsink作成は行わない)")
    subprocess.run(["pulseaudio", "-D", "--exit-idle-time=-1", "--disallow-exit"], check=False)
    time.sleep(2.0)


def upload_to_s3(recording_succeeded):
    import boto3

    client = boto3.client("s3")
    prefix = f"{RUN_ID}"

    targets = [(LOCAL_STDOUT_LOG, "record_stdout.log")]
    if recording_succeeded:
        targets.insert(0, (LOCAL_VIDEO, "video.mp4"))
    else:
        log("WARNING: 録画スクリプトが異常終了したためvideo.mp4はアップロードしません(ログのみアップロードします)")

    for local_path, suffix in targets:
        if not os.path.exists(local_path):
            log(f"WARNING: アップロード対象が見つかりません: {local_path}")
            continue
        key = f"{prefix}/{suffix}"
        t0 = time.time()
        client.upload_file(local_path, OUTPUT_BUCKET, key)
        size_mb = os.path.getsize(local_path) / (1024 * 1024)
        log(f"アップロード完了: s3://{OUTPUT_BUCKET}/{key} ({size_mb:.1f}MB, {time.time()-t0:.1f}s)")


def main():
    os.makedirs(LOCAL_OUTPUT_DIR, exist_ok=True)
    log(f"録画開始 game={GAME} replay={REPLAY_FILE or '(既定値)'} run_id={RUN_ID}")

    start_pulseaudio()

    cmd = [
        "python3", f"{REPO}/scripts/25_record_replay_e2e_multigame.py",
        "--game", GAME,
        "--output", LOCAL_VIDEO,
        "--max-attempts", MAX_ATTEMPTS,
    ]
    if REPLAY_FILE:
        cmd += ["--replay", REPLAY_FILE]
    if WATERMARK_PATH:
        cmd += ["--watermark", WATERMARK_PATH, "--watermark-width", WATERMARK_WIDTH]
        log(f"ウォーターマーク合成あり: {WATERMARK_PATH} (width={WATERMARK_WIDTH})")
    if UPSCALE_720P:
        cmd += ["--upscale-720p"]
        log("録画と同時に720pへアップスケールします")
    if RECORD_SECONDS:
        cmd += ["--record-seconds", RECORD_SECONDS]
        log(f"record-secondsモード: {RECORD_SECONDS}秒で打ち切ります")
    if THPRAC:
        cmd += ["--thprac"]
        log("thpracをアタッチします(--thprac)")

    wall_t0 = time.time()
    with open(LOCAL_STDOUT_LOG, "w") as logf:
        proc = subprocess.run(
            cmd,
            stdout=logf, stderr=subprocess.STDOUT,
        )
    wall_elapsed = time.time() - wall_t0
    log(f"録画スクリプト終了 exit_code={proc.returncode} wall_elapsed={wall_elapsed:.1f}s")

    upload_to_s3(recording_succeeded=(proc.returncode == 0))

    log(f"全工程完了 total_wall_elapsed={time.time()-wall_t0:.1f}s")
    sys.exit(proc.returncode)


if __name__ == "__main__":
    main()
