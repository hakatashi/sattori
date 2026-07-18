#!/usr/bin/env python3
"""録画済み動画を 720p へアップスケールする(Sattori ワーカー)。

th07(妖々夢)のような 640x480 相当の低解像度録画は、そのまま YouTube へ
アップロードすると 60fps として認識されないことが判明した。ユーザーの利便性を
考え、録画完了後に別ファイルとして 720p 版を追加で生成する
(touhou-recorder reports/21)。

録画と同時にアップスケールする方式は、4vCPU 構成(実用下限)で重複フレーム率を
2倍以上悪化させることが検証で分かっているため採用しない。録画には一切影響を
与えない「録画完了後の別ステップ」として実装する。

出力解像度は入力のアスペクト比を保って高さ720pxに合わせる(th07の640x480なら
960x720)。「720p」という呼称に引きずられて1280x720(16:9)へ固定すると、
4:3コンテンツが横方向だけ引き伸ばされて歪むため(reports/21)。
"""
import json
import subprocess
import time

TARGET_HEIGHT = 720
# on_progress コールバックを呼ぶ最小間隔(秒)。DynamoDBへの書き込み頻度を抑える。
PROGRESS_REPORT_INTERVAL_SEC = 10.0


def probe_resolution(input_path):
    out = subprocess.run(
        [
            "ffprobe", "-v", "error", "-select_streams", "v:0",
            "-show_entries", "stream=width,height", "-of", "json", input_path,
        ],
        capture_output=True, text=True, check=True,
    ).stdout
    stream = json.loads(out)["streams"][0]
    return stream["width"], stream["height"]


def probe_duration(input_path):
    out = subprocess.run(
        [
            "ffprobe", "-v", "error", "-show_entries", "format=duration",
            "-of", "json", input_path,
        ],
        capture_output=True, text=True, check=True,
    ).stdout
    duration = json.loads(out)["format"].get("duration")
    return float(duration) if duration is not None else None


def upscale_to_720p(input_path, output_path, on_progress=None):
    """input_path の動画をアスペクト比を保ったまま高さ720pxへ変換する。

    on_progress が指定されていれば、変換の進捗率(0-100のfloat、完了直前まで)を
    およそ PROGRESS_REPORT_INTERVAL_SEC 秒間隔で呼び出す。
    """
    width, height = probe_resolution(input_path)
    target_width = round(width * TARGET_HEIGHT / height / 2) * 2
    cmd = [
        "ffmpeg", "-y", "-i", input_path,
        "-vf", f"scale={target_width}:{TARGET_HEIGHT}:flags=lanczos",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
        "-c:a", "copy",
        output_path,
    ]

    total_duration = probe_duration(input_path) if on_progress else None
    if on_progress is None or not total_duration:
        subprocess.run(cmd, check=True)
        return

    proc = subprocess.Popen(
        [*cmd[:-1], "-progress", "pipe:1", "-nostats", cmd[-1]],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
    )
    last_reported = 0.0
    for line in proc.stdout:
        line = line.strip()
        if not line.startswith("out_time_ms="):
            continue
        try:
            # ffmpeg の `-progress` 出力は `out_time_ms` という名前だが、実体は
            # マイクロ秒単位(ffmpeg既知の命名の癖)。
            out_time_us = int(line.split("=", 1)[1])
        except ValueError:
            continue
        now = time.monotonic()
        if now - last_reported < PROGRESS_REPORT_INTERVAL_SEC:
            continue
        last_reported = now
        percent = min(99.0, out_time_us / 1_000_000 / total_duration * 100)
        on_progress(percent)
    proc.wait()
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg によるアップスケール変換に失敗しました (exit_code={proc.returncode})")
