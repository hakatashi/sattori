#!/usr/bin/env python3
"""本番の sattori-worker-gpu コンテナ内で、1本の録画と配信版の変換を行う(フェーズ94)。

scripts/92_worker_run.py との違いは、倍速の配信版を`-r 60`で変換すること(sattori-dev#322の修正相当。
現行の`fps`フィルタのままだと約45fpsへ落ちる、reports/92 §4)。等倍は本番の変換のまま。

`entrypoint.py` のS3・DynamoDB・Step Functionsへの書き込みだけを除いたもの。タイトル資産の取得
(`title_assets.ensure_title_assets`)・録画(`record_th06nc.py`)・配信版の変換
(`convert.convert_for_delivery`)は本番のコードをそのまま呼ぶ。

環境変数は本番の `apps/api/src/workerEnv.ts` と同じ(`FPS_LIMIT_TARGET_HZ`, `TH06NC_RESOLUTION`, `GPU_WORKER`)。

Usage(コンテナ内):
  python3 /verify/94_worker_run.py --replay /replays/th6_01.rpy --out /out/<label> \
    --score 49260900 --duration 1022
"""
import argparse
import glob
import json
import os
import shutil
import subprocess
import sys
import time

sys.path.insert(0, "/app")

import boto3  # noqa: E402

import pulse  # noqa: E402
from convert import (  # noqa: E402
    build_convert_cmd, convert_for_delivery, needs_separate_raw_output, probe_audio_sample_rate, probe_resolution,
)
from recording import gpu_worker, recording_time_scale  # noqa: E402
from title_assets import ensure_title_assets  # noqa: E402

WATERMARK_ASSET = "/app/assets/watermark/watermark-60fps.webm"
FPS_FILTER = ",fps=60:start_time=0"


def log(msg):
    print(f"[94_worker_run {time.strftime('%H:%M:%S')}] {msg}", flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--replay", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--score", required=True)
    ap.add_argument("--duration", required=True)
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    timing = {"start": time.time()}

    s3 = boto3.client("s3", region_name="eu-south-2")
    ensure_title_assets(s3, os.environ["TITLE_ASSETS_BUCKET"], "th06nc", log=log)
    timing["assets_done"] = time.time()

    subprocess.run(["pulseaudio", "-D", "--exit-idle-time=-1", "--disallow-exit"], check=False)
    time.sleep(2.0)

    video = f"{args.out}/video.mp4"
    desync = f"{args.out}/desync_result.json"
    timeout = f"{args.out}/timeout_result.json"
    cut_path = f"{args.out}/cut_result.json"
    rc = subprocess.run([
        "python3", "/app/record_th06nc.py", "--replay-path", args.replay, "--output", video,
        "--progress-dir", f"{args.out}/progress", "--diagnostics-dir", f"{args.out}/diagnostics",
        "--pulse-sink", pulse.sink_name_for_job("phase94"),
        "--expected-duration-seconds", args.duration, "--expected-score", args.score,
        "--desync-result-path", desync, "--timeout-result-path", timeout, "--cut-result-path", cut_path,
    ]).returncode
    timing["record_done"] = time.time()
    for path in glob.glob("/app/instances/*/*.log"):
        shutil.copy(path, f"{args.out}/{os.path.basename(path)}")
    timing["record_rc"] = rc
    if rc == 0 and os.path.exists(video):
        cut = {"startSec": None, "endSec": None}
        if os.path.exists(cut_path):
            with open(cut_path) as f:
                cut = json.load(f)
        time_scale = recording_time_scale()
        width, height = probe_resolution(video)
        separate_raw = needs_separate_raw_output(width, height, time_scale)
        log(f"変換開始: {width}x{height} time_scale={time_scale} cut={cut} separate_raw={separate_raw}")
        if time_scale != 1.0:
            cmd = build_convert_cmd(
                video, f"{args.out}/video_delivery.mp4", width=width, height=height, time_scale=time_scale,
                watermark_path=WATERMARK_ASSET, audio_sample_rate=probe_audio_sample_rate(video),
                gpu_encode=gpu_worker(), cut_start=cut.get("startSec"), cut_end=cut.get("endSec"),
            )
            i = cmd.index("-filter_complex") + 1
            if FPS_FILTER not in cmd[i]:
                raise SystemExit(f"fpsフィルタが見つかりません: {cmd[i]}")
            cmd[i] = cmd[i].replace(FPS_FILTER, "")
            cmd[-1:-1] = ["-r", "60"]
            with open(f"{args.out}/ffmpeg_upscale.log", "w") as f:
                subprocess.run(cmd, check=True, stdin=subprocess.DEVNULL, stdout=f, stderr=subprocess.STDOUT)
        else:
          convert_for_delivery(
            video, f"{args.out}/video_delivery.mp4", time_scale=time_scale,
            cut_start=cut.get("startSec"), cut_end=cut.get("endSec"),
            raw_output_path=f"{args.out}/video_raw.mp4" if separate_raw else None,
            watermark_path=WATERMARK_ASSET, log=log,
            ffmpeg_log_path=f"{args.out}/ffmpeg_upscale.log", gpu_encode=gpu_worker(),
        )
        timing["convert_done"] = time.time()
    with open(f"{args.out}/timing.json", "w") as f:
        json.dump(timing, f)
    log(f"timing={timing}")
    raise SystemExit(rc)


if __name__ == "__main__":
    main()
